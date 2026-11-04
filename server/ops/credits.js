'use strict';

/**
 * Credits: the prepaid USD balance for metered services (AI Exchange D1, D2). All amounts are integer nano-USD (1e-9 USD),
 * represented as JS BigInt. The ledger account for a (subject, project_id) uses kind='usd_credit',
 * currency='nano-usd' and owner_subject='<subject>:<project_id>'. Holds are reservations; settlement moves
 * the actual charge to platform_revenue:nano-usd and releases the unused reservation. Sandbox grants create
 * synthetic credit from usd_credit_sandbox:nano-usd and are only available when BILLING_CREDITS_SANDBOX=1.
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
    credit: (subject, projectId) => ({ kind: 'usd_credit', owner: `${subject}:${projectId}`, currency: CURRENCY }),
    sandbox: () => ({ kind: 'usd_credit_sandbox', owner: null, currency: CURRENCY }),
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
    return { kind: 'usd_credit', owner, currency: CURRENCY, subject, projectId };
}

function assertEnabled(config) {
    if (!config.credits || !config.credits.enabled) fail(503, 'billing.not_enabled', 'BILLING_CREDITS is off');
}

function assertSandbox(config) {
    if (!config.credits || !config.credits.sandbox) fail(503, 'billing.sandbox_disabled', 'BILLING_CREDITS_SANDBOX is off');
}

async function assertNotFrozen(db) {
    if (await isFrozen(db)) fail(503, 'billing.frozen', 'the economy is frozen: inference writes are refused');
}

/** The account row id for a (subject, project_id), selected FOR UPDATE. Creates the account and balance row if absent. */
async function lockAccount(db, subject, projectId, nowIso) {
    const owner = `${subject}:${projectId}`;
    let row = await db.prepare(`SELECT a.id FROM accounts a WHERE a.kind = 'usd_credit' AND a.owner_subject = ? AND a.currency = 'nano-usd'`).get(owner);
    if (!row) {
        // Two first holds at once: one inserts, the other finds it (the account's unique key), never a 500.
        await db.prepare(`INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES ('usd_credit', ?, 'nano-usd', ?)
            ON CONFLICT DO NOTHING`).run(owner, nowIso);
        row = await db.prepare(`SELECT a.id FROM accounts a WHERE a.kind = 'usd_credit' AND a.owner_subject = ? AND a.currency = 'nano-usd'`).get(owner);
        await db.prepare('INSERT INTO account_balances (account_id, balance, updated_at) VALUES (?, 0, ?) ON CONFLICT DO NOTHING').run(row.id, nowIso);
    }
    // Re-select FOR UPDATE to serialize concurrent holds on the same account.
    await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(row.id);
    return row.id;
}

/** Sum of active holds for an account. */
async function heldOnAccount(db, accountId) {
    const r = await db.prepare(`SELECT COALESCE(SUM(held_nano_usd), 0)::text AS held FROM credit_holds
        WHERE account_id = ? AND status IN ('active', 'extended')`).get(accountId);
    return BigInt(String(r.held));
}

/** Available balance = credit balance - active holds. */
async function available(db, accountId) {
    const row = await db.prepare(`SELECT b.balance::text AS balance FROM account_balances b WHERE b.account_id = ?`).get(accountId);
    const bal = BigInt(String(row.balance));
    return bal - await heldOnAccount(db, accountId);
}

function presentHold(row, availableAfter = null) {
    return {
        hold_id: row.id,
        subject: { type: 'user', id: row.subject },
        project_id: row.project_id,
        credential_id: row.credential_id || null,
        service: row.service || 'ai',
        held_nano_usd: String(row.held_nano_usd),
        // What the account has left to hold after this one (null when not read with the hold).
        available_nano_usd: availableAfter == null ? null : String(availableAfter < 0n ? 0n : availableAfter),
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
        shortfall_nano_usd: String(row.shortfall_nano_usd == null ? 0 : row.shortfall_nano_usd),
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
    // Which metered service spends the credit (D9): AI inference today; compute and others later.
    const service = String(input.service == null ? 'ai' : input.service);
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(service)) fail(422, 'billing.invalid_input', 'service is a lowercase service name (ai, run, ...)');
    const leaseSeconds = Math.max(1, Math.min(config.credits.leaseSeconds || 300, 86400));

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);
        const existing = await db.prepare('SELECT * FROM credit_holds WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) {
            if (existing.request_fingerprint !== fingerprint) fail(409, 'billing.hold_key_reused', 'the same idempotency_key with a different fingerprint is already used');
            return { hold: presentHold(existing, await available(db, existing.account_id)), replay: true };
        }
        const accountId = await lockAccount(db, subject, projectId, nowIso);
        // The same key at the same moment: the account lock serializes them, so the second sees the first's hold here.
        const raced = await db.prepare('SELECT * FROM credit_holds WHERE idempotency_key = ?').get(idempotencyKey);
        if (raced) {
            if (raced.request_fingerprint !== fingerprint) fail(409, 'billing.hold_key_reused', 'the same idempotency_key with a different fingerprint is already used');
            return { hold: presentHold(raced, await available(db, raced.account_id)), replay: true };
        }
        const avail = await available(db, accountId);
        if (avail < maxNano) fail(402, 'billing.insufficient_funds', `insufficient inference credit: ${avail} < ${maxNano} nano-USD`, { available: String(avail), required: String(maxNano) });

        const holdId = prefixedId('hld', now);
        const leaseExpires = iso(now + leaseSeconds * 1000);
        const row = await db.prepare(`INSERT INTO credit_holds
            (id, idempotency_key, subject, project_id, credential_id, service, account_id, held_nano_usd, max_nano_usd, rate_version, request_fingerprint, lease_expires_at, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, 'active', ?::timestamptz, ?::timestamptz) RETURNING *`).get(
            holdId, idempotencyKey, subject, projectId, credentialId, service, accountId, maxNano, maxNano, rateVersion, fingerprint, leaseExpires, nowIso, nowIso);
        return { hold: presentHold(row, avail - maxNano), replay: false };
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
        const hold = await db.prepare('SELECT * FROM credit_holds WHERE id = ? FOR UPDATE').get(holdId);
        if (!hold) fail(404, 'billing.hold_not_found', `no hold ${holdId}`);
        // Past its lease but not yet swept, a hold still counts against the balance, so it may still grow: the sweeper alone
        // decides expiry (a settle that arrives late must not lose billable usage).
        if (TERMINAL_STATUSES.includes(hold.status)) fail(409, 'billing.hold_terminal', `hold ${holdId} is already ${hold.status}`);

        await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(hold.account_id);
        const avail = await available(db, hold.account_id);
        if (avail < addNano) fail(402, 'billing.insufficient_funds', `cannot extend hold: ${avail} < ${addNano} nano-USD available`, { available: String(avail), required: String(addNano) });

        const newHeld = BigInt(String(hold.held_nano_usd)) + addNano;
        const row = await db.prepare(`UPDATE credit_holds SET held_nano_usd = ?, max_nano_usd = ?, status = 'extended', lease_expires_at = GREATEST(lease_expires_at, ?::timestamptz), updated_at = ?::timestamptz WHERE id = ? RETURNING *`).get(
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

    const tokenOk = (v) => Number.isSafeInteger(v) && v >= 0;
    if (!tokenOk(usage.input_tokens) || !tokenOk(usage.cached_read_tokens) || !tokenOk(usage.cache_write_tokens) || !tokenOk(usage.output_tokens)) {
        fail(422, 'billing.invalid_input', 'usage must have non-negative integer token counts');
    }
    if (!retail.version || typeof retail.nano_usd_per_m !== 'object' || typeof retail.per_request_nano_usd === 'undefined') {
        fail(422, 'billing.invalid_input', 'retail must have version, nano_usd_per_m and per_request_nano_usd');
    }

    const charge = byok ? 0n : computeCharge(usage, retail);

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);

        const replayOf = (row) => {
            // A key names one settlement of one hold: the same key for another hold is a conflict, never its answer.
            if (row.hold_id !== holdId) fail(409, 'billing.settle_key_reused', 'this idempotency_key already settled another hold');
            return { settlement: presentSettlement(row), replay: true };
        };
        const existing = await db.prepare('SELECT * FROM credit_settlements WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) return replayOf(existing);

        const hold = await db.prepare('SELECT * FROM credit_holds WHERE id = ? FOR UPDATE').get(holdId);
        if (!hold) fail(404, 'billing.hold_not_found', `no hold ${holdId}`);
        // Two settles at once with one key: the hold lock serializes them; the second sees the first's settlement.
        const raced = await db.prepare('SELECT * FROM credit_settlements WHERE idempotency_key = ?').get(idempotencyKey);
        if (raced) return replayOf(raced);
        if (TERMINAL_STATUSES.includes(hold.status)) fail(409, 'billing.hold_terminal', `hold ${holdId} is already ${hold.status}`);

        await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(hold.account_id);
        const held = BigInt(String(hold.held_nano_usd));
        // Usage beyond the hold (a stream longer than its estimate that was not extended) is taken from what the account
        // still has, never below zero; what cannot be collected is recorded as a shortfall for reconciliation, so
        // billable usage is never silently lost and the balance never goes negative.
        let collected = charge;
        let shortfall = 0n;
        if (charge > held) {
            const room = held + await available(db, hold.account_id);   // the account's other room (this hold excluded)
            if (charge > room) { collected = room; shortfall = charge - room; }
        }
        const released = collected >= held ? 0n : held - collected;

        const journalId = prefixedId('txn', now);
        const { txn } = await post(ctx, {
            type: 'credit', idempotencyKey: `credit:settle:${idempotencyKey}`, actor: input.actor || ACTOR,
            fromSubject: hold.subject, toSubject: null,
            entries: [entry(A_INF.credit(hold.subject, hold.project_id), -collected), entry(A_INF.revenue(), collected)],
            metadata: {
                credit: 'settle', hold_id: holdId, project_id: hold.project_id, credential_id: hold.credential_id,
                usage, retail, byok, supply_cost_nano_usd: String(supplyCost), attempts, released_nano_usd: String(released),
                charge_nano_usd: String(charge), shortfall_nano_usd: String(shortfall),
            },
        });

        await db.prepare(`UPDATE credit_holds SET status = 'settled', held_nano_usd = 0, updated_at = ?::timestamptz WHERE id = ?`).run(nowIso, holdId);
        const row = await db.prepare(`INSERT INTO credit_settlements
            (id, hold_id, idempotency_key, subject, project_id, account_id, charge_nano_usd, released_nano_usd, shortfall_nano_usd, journal_id, usage, retail, supply_cost_nano_usd, byok, attempts, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?::jsonb, ?::timestamptz) RETURNING *`).get(
            prefixedId('stl', now), holdId, idempotencyKey, hold.subject, hold.project_id, hold.account_id,
            collected, released, shortfall, txn.id, JSON.stringify(usage), JSON.stringify(retail), supplyCost, byok, JSON.stringify(attempts), nowIso);
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
        const hold = await db.prepare('SELECT * FROM credit_holds WHERE id = ? FOR UPDATE').get(holdId);
        if (!hold) fail(404, 'billing.hold_not_found', `no hold ${holdId}`);
        if (hold.status === 'released') return { hold_id: holdId, released_nano_usd: String(hold.max_nano_usd) };
        if (hold.status === 'settled') fail(409, 'billing.hold_terminal', `hold ${holdId} is already settled`);
        if (TERMINAL_STATUSES.includes(hold.status)) fail(409, 'billing.hold_terminal', `hold ${holdId} is already ${hold.status}`);

        const released = BigInt(String(hold.held_nano_usd));
        await db.prepare(`UPDATE credit_holds SET status = 'released', held_nano_usd = 0, updated_at = ?::timestamptz WHERE id = ?`).run(nowIso, holdId);
        return { hold_id: holdId, released_nano_usd: String(released) };
    });
}

/**
 * Release holds whose lease has expired. Called by the scheduled sweeper.
 */
async function sweepExpired(ctx) {
    const { db, config } = ctx;
    if (!config.credits || !config.credits.enabled) return { released: 0 };
    if (await isFrozen(db)) return { released: 0, frozen: true };
    const nowIso = iso(ctx.now());
    const due = await db.prepare(`SELECT id FROM credit_holds WHERE status IN ('active', 'extended') AND lease_expires_at <= ?::timestamptz ORDER BY lease_expires_at, id FOR UPDATE`).all(nowIso);
    let released = 0;
    for (const { id } of due) {
        await db.prepare(`UPDATE credit_holds SET status = 'expired', held_nano_usd = 0, updated_at = ?::timestamptz WHERE id = ? AND status IN ('active', 'extended')`).run(nowIso, id);
        released++;
    }
    return { released };
}

/**
 * Sandbox grant: add synthetic inference credit to an account. Only when BILLING_CREDITS_SANDBOX=1.
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
            type: 'credit', idempotencyKey: `credit:sandbox:${grantId}`, actor: input.actor || ACTOR, toSubject: subject,
            test: true,
            entries: [entry(A_INF.sandbox(), -amount), entry(A_INF.credit(subject, projectId), amount)],
            metadata: { credit: 'sandbox_grant', grant_id: grantId, project_id: projectId, reason, amount_nano_usd: String(amount) },
        });
        await db.prepare(`INSERT INTO credit_sandbox_grants (id, subject, project_id, account_id, amount_nano_usd, journal_id, reason, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::timestamptz)`).run(grantId, subject, projectId, accountId, amount, txn.id, reason, nowIso);
        return { grant_id: grantId, amount_nano_usd: String(amount), balance_nano_usd: String(await balance(db, A_INF.credit(subject, projectId))) };
    });
}

/** Read a hold by id. */
async function findHold(db, id) {
    const row = await db.prepare('SELECT * FROM credit_holds WHERE id = ?').get(id);
    return row ? presentHold(row) : null;
}

/** Read a settlement by hold id or id. */
async function findSettlement(db, { holdId, id } = {}) {
    const row = holdId
        ? await db.prepare('SELECT * FROM credit_settlements WHERE hold_id = ?').get(holdId)
        : await db.prepare('SELECT * FROM credit_settlements WHERE id = ?').get(id);
    return row ? presentSettlement(row) : null;
}

module.exports = {
    createHold, extendHold, settleHold, releaseHold, sweepExpired, sandboxGrant,
    findHold, findSettlement, computeCharge, available, A_INF, CURRENCY,
};
