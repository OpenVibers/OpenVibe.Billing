'use strict';

/**
 * High-precision inference subledger (AI Exchange D1, D2). All amounts are integer nano-USD (1e-9 USD),
 * represented as JS BigInt. The ledger account for a (subject, project_id) uses kind='inference_credit',
 * currency='nano-usd' and owner_subject='<subject>:<project_id>'. Holds are reservations; settlement moves
 * the actual charge to platform_revenue:nano-usd and releases the unused reservation. Sandbox grants create
 * synthetic credit from inference_sandbox:nano-usd and are only available when BILLING_INFERENCE_SANDBOX=1.
 *
 * Nothing here goes through chargeFor or the Vibes bits ledger.
 */
const { ids } = require('openvibe-contracts');
const { post, balance, requireFunds, money, iso, prefixedId } = require('../ledger');
const { A, entry, fail, userSubject, positiveInt, text, isFrozen } = require('./common');

const CURRENCY = 'nano-usd';
const ACTOR = { type: 'service', id: 'billing' };
const ACTIVE_STATUSES = ['active', 'extended'];
const TERMINAL_STATUSES = ['settled', 'released', 'expired'];

const A_INF = {
    credit: (subject, projectId) => ({ kind: 'inference_credit', owner: `${subject}:${projectId}`, currency: CURRENCY }),
    sandbox: () => ({ kind: 'inference_sandbox', owner: null, currency: CURRENCY }),
    revenue: () => ({ kind: 'platform_revenue', owner: null, currency: CURRENCY }),
};

const nano = (v, field) => {
    if (typeof v === 'bigint') {
        if (v < 0n) fail(422, 'billing.invalid_amount', `${field} must be non-negative`);
        return v;
    }
    if (typeof v === 'number') {
        if (!Number.isSafeInteger(v) || v < 0) fail(422, 'billing.invalid_amount', `${field} must be a safe integer`);
        return BigInt(v);
    }
    if (typeof v === 'string' && /^[0-9]+$/.test(v)) {
        return BigInt(v);
    }
    fail(422, 'billing.invalid_amount', `${field} must be integer nano-USD`);
};

const nanoNonNeg = nano;

function parseSubject(v) {
    if (v && typeof v === 'object' && v.type === 'user' && typeof v.id === 'string') return v.id;
    if (typeof v === 'string' && v.startsWith('user:')) return v.slice(5);
    return userSubject(v);
}

function accountIdOf(owner) {
    const [subject, projectId] = String(owner || ':').split(':');
    return { kind: 'inference_credit', owner, currency: CURRENCY, subject, projectId };
}

function assertEnabled(config) {
    if (!config.inference || !config.inference.enabled) fail(503, 'billing.not_enabled', 'BILLING_INFERENCE_SUBLEDGER is off');
}

function assertSandbox(config) {
    if (!config.inference || !config.inference.sandbox) fail(503, 'billing.sandbox_disabled', 'BILLING_INFERENCE_SANDBOX is off');
}

async function assertNotFrozen(db) {
    if (await isFrozen(db)) fail(503, 'billing.frozen', 'the economy is frozen: inference writes are refused');
}

/** The account row id for a (subject, project_id), selected FOR UPDATE. Creates the account and balance row if absent. */
async function lockAccount(db, subject, projectId, nowIso) {
    const owner = `${subject}:${projectId}`;
    let row = await db.prepare(`SELECT a.id FROM accounts a WHERE a.kind = 'inference_credit' AND a.owner_subject = ? AND a.currency = 'nano-usd'`).get(owner);
    if (!row) {
        const ins = await db.prepare(`INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES ('inference_credit', ?, 'nano-usd', ?) RETURNING id`).run(owner, nowIso);
        row = { id: ins.lastInsertRowid };
        await db.prepare('INSERT INTO account_balances (account_id, balance, updated_at) VALUES (?, 0, ?)').run(row.id, nowIso);
    }
    // Re-select FOR UPDATE to serialize concurrent holds on the same account.
    await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(row.id);
    return row.id;
}

/** Sum of active holds for an account. */
async function heldOnAccount(db, accountId) {
    const r = await db.prepare(`SELECT COALESCE(SUM(held_nano_usd), 0)::text AS held FROM inference_holds
        WHERE account_id = ? AND status IN ('active', 'extended')`).get(accountId);
    return BigInt(String(r.held));
}

/** Available balance = credit balance - active holds. */
async function available(db, accountId) {
    const row = await db.prepare(`SELECT b.balance::text AS balance FROM account_balances b WHERE b.account_id = ?`).get(accountId);
    const bal = BigInt(String(row.balance));
    return bal - await heldOnAccount(db, accountId);
}

function presentHold(row) {
    return {
        hold_id: row.id,
        subject: { type: 'user', id: row.subject },
        project_id: row.project_id,
        credential_id: row.credential_id || null,
        held_nano_usd: String(row.held_nano_usd),
        available_nano_usd: String(row.held_nano_usd),
        max_nano_usd: row.max_nano_usd == null ? null : String(row.max_nano_usd),
        rate_version: row.rate_version,
        request_fingerprint: row.request_fingerprint,
        lease_expires_at: row.lease_expires_at,
        status: row.status,
        created_at: row.created_at,
    };
}

function presentSettlement(row) {
    return {
        settlement_id: row.id,
        hold_id: row.hold_id,
        subject: { type: 'user', id: row.subject },
        project_id: row.project_id,
        charge_nano_usd: String(row.charge_nano_usd),
        released_nano_usd: String(row.released_nano_usd),
        journal_id: row.journal_id,
        usage: row.usage,
        retail: row.retail,
        supply_cost_nano_usd: String(row.supply_cost_nano_usd),
        byok: !!row.byok,
        attempts: row.attempts,
        created_at: row.created_at,
    };
}

/**
 * Create or replay a hold. Idempotent by idempotency_key + request_fingerprint.
 * Returns { hold, replay }.
 */
async function createHold(ctx, input) {
    const { db, config } = ctx;
    assertEnabled(config);
    await assertNotFrozen(db);
    const subject = parseSubject(input.subject);
    const projectId = text(input.project_id, 'project_id');
    if (!projectId || !/^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(projectId)) fail(422, 'billing.invalid_input', 'project_id must be a project ULID');
    const maxNano = nanoNonNeg(input.max_nano_usd, 'max_nano_usd');
    const rateVersion = text(input.rate_version, 'rate_version', 200) || fail(422, 'billing.invalid_input', 'rate_version is required');
    const fingerprint = text(input.request_fingerprint, 'request_fingerprint', 1024) || fail(422, 'billing.invalid_input', 'request_fingerprint is required');
    const idempotencyKey = text(input.idempotency_key, 'idempotency_key', 128) || fail(422, 'billing.invalid_input', 'idempotency_key is required');
    const credentialId = input.credential_id ? text(input.credential_id, 'credential_id') : null;
    const leaseSeconds = Math.max(1, Math.min(config.inference.leaseSeconds || 300, 86400));

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);
        const existing = await db.prepare('SELECT * FROM inference_holds WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) {
            if (existing.request_fingerprint !== fingerprint) fail(409, 'billing.hold_key_reused', 'the same idempotency_key with a different fingerprint is already used');
            return { hold: presentHold(existing), replay: true };
        }
        const accountId = await lockAccount(db, subject, projectId, nowIso);
        const avail = await available(db, accountId);
        if (avail < maxNano) fail(402, 'billing.insufficient_funds', `insufficient inference credit: ${avail} < ${maxNano} nano-USD`, { available: String(avail), required: String(maxNano) });

        const holdId = prefixedId('hld', now);
        const leaseExpires = iso(now + leaseSeconds * 1000);
        const row = await db.prepare(`INSERT INTO inference_holds
            (id, idempotency_key, subject, project_id, credential_id, account_id, held_nano_usd, max_nano_usd, rate_version, request_fingerprint, lease_expires_at, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, 'active', ?::timestamptz, ?::timestamptz) RETURNING *`).get(
            holdId, idempotencyKey, subject, projectId, credentialId, accountId, maxNano, maxNano, rateVersion, fingerprint, leaseExpires, nowIso, nowIso);
        return { hold: presentHold(row), replay: false };
    });
}

/**
 * Extend an active hold. Grows held_nano_usd by add_nano_usd; answers 402 if the account has no room.
 */
async function extendHold(ctx, input) {
    const { db, config } = ctx;
    assertEnabled(config);
    await assertNotFrozen(db);
    const holdId = text(input.hold_id, 'hold_id', 100) || fail(422, 'billing.invalid_input', 'hold_id is required');
    const addNano = nanoNonNeg(input.add_nano_usd, 'add_nano_usd');

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);
        const hold = await db.prepare('SELECT * FROM inference_holds WHERE id = ? FOR UPDATE').get(holdId);
        if (!hold) fail(404, 'billing.hold_not_found', `no hold ${holdId}`);
        if (TERMINAL_STATUSES.includes(hold.status)) fail(409, 'billing.hold_terminal', `hold ${holdId} is already ${hold.status}`);
        if (new Date(hold.lease_expires_at).getTime() <= now) fail(409, 'billing.hold_expired', `hold ${holdId} has expired`);

        await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(hold.account_id);
        const avail = await available(db, hold.account_id);
        if (avail < addNano) fail(402, 'billing.insufficient_funds', `cannot extend hold: ${avail} < ${addNano} nano-USD available`, { available: String(avail), required: String(addNano) });

        const newHeld = BigInt(String(hold.held_nano_usd)) + addNano;
        const row = await db.prepare(`UPDATE inference_holds SET held_nano_usd = ?, max_nano_usd = ?, status = 'extended', lease_expires_at = GREATEST(lease_expires_at, ?::timestamptz), updated_at = ?::timestamptz WHERE id = ? RETURNING *`).get(
            newHeld, newHeld, iso(now + 60 * 1000), nowIso, holdId);
        return { hold: presentHold(row) };
    });
}

/** Compute retail charge from usage and rate (ceil once per component). */
function computeCharge(usage, retail) {
    const perM = retail.nano_usd_per_m;
    const components = [
        [BigInt(usage.input_tokens || 0), nano(perM.input, 'retail.nano_usd_per_m.input')],
        [BigInt(usage.cached_read_tokens || 0), nano(perM.cached_read, 'retail.nano_usd_per_m.cached_read')],
        [BigInt(usage.cache_write_tokens || 0), nano(perM.cache_write, 'retail.nano_usd_per_m.cache_write')],
        [BigInt(usage.output_tokens || 0), nano(perM.output, 'retail.nano_usd_per_m.output')],
    ];
    let charge = 0n;
    for (const [tokens, rate] of components) {
        if (tokens === 0n || rate === 0n) continue;
        // ceil(tokens * rate / 1_000_000)
        const num = tokens * rate;
        const div = num / 1_000_000n;
        charge += (num % 1_000_000n === 0n ? div : div + 1n);
    }
    charge += nano(retail.per_request_nano_usd, 'retail.per_request_nano_usd');
    return charge;
}

/**
 * Settle a hold. Idempotent by idempotency_key. Charges the computed retail amount, releases the rest.
 * Returns { settlement, replay }.
 */
async function settleHold(ctx, input) {
    const { db, config } = ctx;
    assertEnabled(config);
    await assertNotFrozen(db);
    const holdId = text(input.hold_id, 'hold_id', 100) || fail(422, 'billing.invalid_input', 'hold_id is required');
    const idempotencyKey = text(input.idempotency_key, 'idempotency_key', 128) || fail(422, 'billing.invalid_input', 'idempotency_key is required');
    const usage = input.usage || {};
    const retail = input.retail || {};
    const byok = !!input.byok;
    const supplyCost = nano(input.supply_cost_nano_usd || '0', 'supply_cost_nano_usd');
    const attempts = Array.isArray(input.attempts) ? input.attempts : [];

    if (typeof usage.input_tokens !== 'number' || typeof usage.cached_read_tokens !== 'number' ||
        typeof usage.cache_write_tokens !== 'number' || typeof usage.output_tokens !== 'number' ||
        usage.input_tokens < 0 || usage.cached_read_tokens < 0 || usage.cache_write_tokens < 0 || usage.output_tokens < 0) {
        fail(422, 'billing.invalid_input', 'usage must have non-negative integer token counts');
    }
    if (!retail.version || typeof retail.nano_usd_per_m !== 'object' || typeof retail.per_request_nano_usd === 'undefined') {
        fail(422, 'billing.invalid_input', 'retail must have version, nano_usd_per_m and per_request_nano_usd');
    }

    const charge = byok ? 0n : computeCharge(usage, retail);

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);

        const existing = await db.prepare('SELECT * FROM inference_settlements WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) return { settlement: presentSettlement(existing), replay: true };

        const hold = await db.prepare('SELECT * FROM inference_holds WHERE id = ? FOR UPDATE').get(holdId);
        if (!hold) fail(404, 'billing.hold_not_found', `no hold ${holdId}`);
        if (TERMINAL_STATUSES.includes(hold.status)) fail(409, 'billing.hold_terminal', `hold ${holdId} is already ${hold.status}`);
        if (new Date(hold.lease_expires_at).getTime() <= now) fail(409, 'billing.hold_expired', `hold ${holdId} has expired`);

        await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(hold.account_id);
        const held = BigInt(String(hold.held_nano_usd));
        if (charge > held) fail(402, 'billing.insufficient_funds', `settlement charge ${charge} exceeds hold ${held} nano-USD`);
        const released = held - charge;

        const journalId = prefixedId('txn', now);
        const { txn } = await post(ctx, {
            type: 'inference', idempotencyKey: `inference:settle:${idempotencyKey}`, actor: input.actor || ACTOR,
            fromSubject: hold.subject, toSubject: null,
            entries: [entry(A_INF.credit(hold.subject, hold.project_id), -charge), entry(A_INF.revenue(), charge)],
            metadata: {
                inference: 'settle', hold_id: holdId, project_id: hold.project_id, credential_id: hold.credential_id,
                usage, retail, byok, supply_cost_nano_usd: String(supplyCost), attempts, released_nano_usd: String(released),
            },
        });

        await db.prepare(`UPDATE inference_holds SET status = 'settled', held_nano_usd = 0, updated_at = ?::timestamptz WHERE id = ?`).run(nowIso, holdId);
        const row = await db.prepare(`INSERT INTO inference_settlements
            (id, hold_id, idempotency_key, subject, project_id, account_id, charge_nano_usd, released_nano_usd, journal_id, usage, retail, supply_cost_nano_usd, byok, attempts, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?::jsonb, ?::timestamptz) RETURNING *`).get(
            prefixedId('stl', now), holdId, idempotencyKey, hold.subject, hold.project_id, hold.account_id,
            charge, released, txn.id, JSON.stringify(usage), JSON.stringify(retail), supplyCost, byok, JSON.stringify(attempts), nowIso);
        return { settlement: presentSettlement(row), replay: false };
    });
}

/**
 * Release a hold with nothing charged. Idempotent: a replay returns the same result.
 */
async function releaseHold(ctx, input) {
    const { db, config } = ctx;
    assertEnabled(config);
    await assertNotFrozen(db);
    const holdId = text(input.hold_id, 'hold_id', 100) || fail(422, 'billing.invalid_input', 'hold_id is required');

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);
        const hold = await db.prepare('SELECT * FROM inference_holds WHERE id = ? FOR UPDATE').get(holdId);
        if (!hold) fail(404, 'billing.hold_not_found', `no hold ${holdId}`);
        if (hold.status === 'released') return { hold_id: holdId, released_nano_usd: String(hold.max_nano_usd) };
        if (hold.status === 'settled') fail(409, 'billing.hold_terminal', `hold ${holdId} is already settled`);
        if (TERMINAL_STATUSES.includes(hold.status)) fail(409, 'billing.hold_terminal', `hold ${holdId} is already ${hold.status}`);

        const released = BigInt(String(hold.held_nano_usd));
        await db.prepare(`UPDATE inference_holds SET status = 'released', held_nano_usd = 0, updated_at = ?::timestamptz WHERE id = ?`).run(nowIso, holdId);
        return { hold_id: holdId, released_nano_usd: String(released) };
    });
}

/**
 * Release holds whose lease has expired. Called by the scheduled sweeper.
 */
async function sweepExpired(ctx) {
    const { db, config } = ctx;
    if (!config.inference || !config.inference.enabled) return { released: 0 };
    if (await isFrozen(db)) return { released: 0, frozen: true };
    const nowIso = iso(ctx.now());
    const due = await db.prepare(`SELECT id FROM inference_holds WHERE status IN ('active', 'extended') AND lease_expires_at <= ?::timestamptz ORDER BY lease_expires_at, id FOR UPDATE`).all(nowIso);
    let released = 0;
    for (const { id } of due) {
        await db.prepare(`UPDATE inference_holds SET status = 'expired', held_nano_usd = 0, updated_at = ?::timestamptz WHERE id = ? AND status IN ('active', 'extended')`).run(nowIso, id);
        released++;
    }
    return { released };
}

/**
 * Sandbox grant: add synthetic inference credit to an account. Only when BILLING_INFERENCE_SANDBOX=1.
 */
async function sandboxGrant(ctx, input) {
    const { db, config } = ctx;
    assertEnabled(config);
    assertSandbox(config);
    await assertNotFrozen(db);
    const subject = parseSubject(input.subject);
    const projectId = text(input.project_id, 'project_id');
    if (!projectId || !/^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(projectId)) fail(422, 'billing.invalid_input', 'project_id must be a project ULID');
    const amount = nanoNonNeg(input.amount_nano_usd, 'amount_nano_usd');
    if (amount === 0n) fail(422, 'billing.invalid_amount', 'amount_nano_usd must be positive');
    const reason = text(input.reason, 'reason', 500) || 'sandbox grant';

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);
        const accountId = await lockAccount(db, subject, projectId, nowIso);
        const grantId = prefixedId('igr', now);
        const { txn } = await post(ctx, {
            type: 'inference', idempotencyKey: `inference:sandbox:${grantId}`, actor: input.actor || ACTOR, toSubject: subject,
            test: true,
            entries: [entry(A_INF.sandbox(), -amount), entry(A_INF.credit(subject, projectId), amount)],
            metadata: { inference: 'sandbox_grant', grant_id: grantId, project_id: projectId, reason, amount_nano_usd: String(amount) },
        });
        await db.prepare(`INSERT INTO inference_sandbox_grants (id, subject, project_id, account_id, amount_nano_usd, journal_id, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::timestamptz)`).run(grantId, subject, projectId, accountId, amount, txn.id, reason, nowIso);
        return { grant_id: grantId, amount_nano_usd: String(amount), balance_nano_usd: String(await balance(db, A_INF.credit(subject, projectId))) };
    });
}

/** Read a hold by id. */
async function findHold(db, id) {
    const row = await db.prepare('SELECT * FROM inference_holds WHERE id = ?').get(id);
    return row ? presentHold(row) : null;
}

/** Read a settlement by hold id or id. */
async function findSettlement(db, { holdId, id } = {}) {
    const row = holdId
        ? await db.prepare('SELECT * FROM inference_settlements WHERE hold_id = ?').get(holdId)
        : await db.prepare('SELECT * FROM inference_settlements WHERE id = ?').get(id);
    return row ? presentSettlement(row) : null;
}

module.exports = {
    createHold, extendHold, settleHold, releaseHold, sweepExpired, sandboxGrant,
    findHold, findSettlement, computeCharge, available, A_INF, CURRENCY,
};
