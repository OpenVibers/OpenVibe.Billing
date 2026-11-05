'use strict';

/**
 * Balance (D12): a person's or a project's prepaid USD, and the two ways a person moves it.
 *
 *   GET  /api/me/balance             personal Balance plus the projects the person administers
 *   POST /api/me/balance/transfers   personal Balance -> a project's Balance (atomic, idempotent, admin only)
 *   POST /api/me/vibes/from-balance  personal Balance -> Vibes, at the pack value rate (atomic, idempotent)
 *
 * A person's Balance is usd_credit owned by user:<usr_id>; a project's is usd_credit owned by project:<prj_id>.
 * Everything is integer nano-USD as BigInt. The two writes are one balanced journal transaction each and are
 * idempotent by their idempotency key; a replay never moves money twice and a different request under the same
 * key is refused. The source only ever spends available Balance (balance minus active holds), so a hold can never
 * be spent out from under a transfer or a Vibes purchase.
 */
const { money, post, balance, iso, prefixedId } = require('../ledger');
const { A, entry, fail, userSubject, positiveInt, isFrozen } = require('./common');
const { A_INF, nano, heldOnAccount, ownerOf } = require('./credits');

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const NANO_PER_USD = 1_000_000_000n;

function assertEnabled(config) {
    if (!config.credits || !config.credits.enabled) fail(404, 'billing.not_enabled', 'Balance is not open yet');
}

async function assertNotFrozen(db) {
    if (await isFrozen(db)) fail(503, 'billing.frozen', 'the economy is frozen: Balance writes are refused');
}

function idempotencyKey(v) {
    const s = String(v == null ? '' : v).trim();
    if (!KEY_RE.test(s)) fail(422, 'billing.invalid_input', 'idempotency_key must be 8-128 characters of letters, digits, dot, colon, underscore or dash');
    return s;
}

/** One side of a Balance read. `projectId` null is the person's own Balance. */
async function presentBalance(ctx, subject, projectId = null) {
    const { db } = ctx;
    const owner = ownerOf(subject, projectId);
    const ownerRef = projectId ? { type: 'project', id: projectId } : { type: 'user', id: subject };
    const row = await db.prepare(`SELECT a.id, b.balance::text AS balance FROM accounts a JOIN account_balances b ON b.account_id = a.id
        WHERE a.kind = 'usd_credit' AND a.owner_subject = ? AND a.currency = 'nano-usd'`).get(owner);
    let bal = 0n;
    let held = 0n;
    if (row) {
        bal = BigInt(String(row.balance));
        held = await heldOnAccount(db, row.id);
    }
    return {
        owner: ownerRef,
        balance_nano_usd: String(bal),
        held_nano_usd: String(held),
        available_nano_usd: String(bal - held < 0n ? 0n : bal - held),
    };
}

/**
 * The person's Balance plus the Balance of every project they administer (role admin or owner, unarchived).
 * Network answers the membership list with Billing's service token; a failed read is an error, never an empty
 * list, because an empty list would hide a project from its admin.
 */
async function readBalance(ctx, subject) {
    assertEnabled(ctx.config);
    const memberships = await ctx.projects.administered(subject);
    const projects = [];
    for (const m of memberships) projects.push(await presentBalance(ctx, null, m.project_id));
    projects.sort((a, b) => (a.owner.id < b.owner.id ? -1 : a.owner.id > b.owner.id ? 1 : 0));
    return { personal: await presentBalance(ctx, subject), projects };
}

/** The person must be an admin (or owner) of an unarchived project before its Balance is touched. */
async function assertProjectAdmin(ctx, subject, projectId) {
    const m = await ctx.projects.member(projectId, subject);
    if (!m || m.archived || !['admin', 'owner'].includes(m.role)) {
        fail(403, 'billing.not_project_admin', 'you are not an admin of that project');
    }
    return m;
}

/**
 * Move money from the person's Balance to a project's Balance. Both accounts are locked inside one serializable
 * transaction; the source spends available (never held) Balance only, so it can never go below zero.
 */
async function transfer(ctx, { subject: rawSubject, toProjectId, amountNanoUsd, idempotencyKey: rawKey }) {
    const { db, config } = ctx;
    assertEnabled(config);
    await assertNotFrozen(db);
    const subject = userSubject(rawSubject, 'subject');
    const projectId = String(toProjectId == null ? '' : toProjectId);
    if (!/^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(projectId)) fail(422, 'billing.invalid_input', 'to_project_id is a project id');
    const amount = nano(amountNanoUsd, 'amount_nano_usd');
    if (amount === 0n) fail(422, 'billing.invalid_amount', 'amount_nano_usd must be positive');
    const key = idempotencyKey(rawKey);
    await assertProjectAdmin(ctx, subject, projectId);

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);
        const check = async () => {
            const row = await db.prepare('SELECT *, amount_nano_usd::text AS amount_text FROM balance_transfers WHERE idempotency_key = ?').get(key);
            if (!row) return null;
            if (row.subject !== subject || row.to_project_id !== projectId || BigInt(row.amount_text) !== amount) {
                fail(409, 'billing.idempotency_key_reused', 'the same idempotency_key was used for another transfer');
            }
            return row;
        };
        const first = await check();
        if (first) return await transferResult(ctx, first, subject, projectId, amount, true);

        const fromId = await requireBalanceAccount(db, subject, null, nowIso);
        // The account lock serializes two transfers with the same key, so the loser sees the winner's row.
        const raced = await check();
        if (raced) return await transferResult(ctx, raced, subject, projectId, amount, true);

        const available = BigInt(String(await availableOf(db, fromId)));
        if (available < amount) fail(402, 'billing.insufficient_funds', `insufficient Balance: ${available} < ${amount} nano-USD`, { available: String(available), required: String(amount) });
        await requireBalanceAccount(db, null, projectId, nowIso);
        const { txn } = await post(ctx, {
            type: 'balance_transfer', idempotencyKey: `balance:transfer:${key}`, actor: { type: 'user', id: subject },
            fromSubject: subject, toSubject: null,
            entries: [entry(A_INF.credit(subject, null), -amount), entry(A_INF.credit(null, projectId), amount)],
            metadata: { balance: 'transfer', idempotency_key: key, to_project_id: projectId, amount_nano_usd: String(amount) },
        });
        const row = await db.prepare(`INSERT INTO balance_transfers (id, idempotency_key, subject, to_project_id, amount_nano_usd, journal_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?::timestamptz) RETURNING *, amount_nano_usd::text AS amount_text`)
            .get(prefixedId('btr', now), key, subject, projectId, amount, txn.id, nowIso);
        return await transferResult(ctx, row, subject, projectId, amount, false);
    });
}

async function transferResult(ctx, row, subject, projectId, amount, replay) {
    return {
        transfer_id: row.id,
        transaction_id: row.journal_id,
        replay,
        amount_nano_usd: String(amount),
        from: await presentBalance(ctx, subject),
        to: await presentBalance(ctx, null, projectId),
    };
}

/** Lock (creating if needed) a real usd_credit account. `projectId` null is the person's own Balance. */
async function requireBalanceAccount(db, subject, projectId, nowIso) {
    const owner = ownerOf(subject, projectId);
    const existing = await db.prepare(`SELECT id FROM accounts WHERE kind = 'usd_credit' AND owner_subject = ? AND currency = 'nano-usd'`).get(owner);
    if (!existing) {
        await db.prepare(`INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES ('usd_credit', ?, 'nano-usd', ?)
            ON CONFLICT DO NOTHING`).run(owner, nowIso);
        const made = await db.prepare(`SELECT id FROM accounts WHERE kind = 'usd_credit' AND owner_subject = ? AND currency = 'nano-usd'`).get(owner);
        await db.prepare('INSERT INTO account_balances (account_id, balance, updated_at) VALUES (?, 0, ?) ON CONFLICT DO NOTHING').run(made.id, nowIso);
    }
    const row = await db.prepare(`SELECT id FROM accounts WHERE kind = 'usd_credit' AND owner_subject = ? AND currency = 'nano-usd'`).get(owner);
    await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(row.id);
    return row.id;
}

/** Balance minus active holds (the only money a write may spend). */
async function availableOf(db, accountId) {
    const row = await db.prepare('SELECT balance::text AS balance FROM account_balances WHERE account_id = ?').get(accountId);
    const bal = BigInt(String(row ? row.balance : '0'));
    return bal - await heldOnAccount(db, accountId);
}

/**
 * Buy Vibes with Balance at the pack value rate: price_nano = ceil(vibes * 1e9 / bits_per_usd), exact to the
 * nano-USD. The USD moves to platform_revenue:nano-usd; the Vibes are minted from fx_conversion in vibes-bits into
 * the person's Vibes account, exactly as purchases.js mints a pack.
 */
async function buyVibes(ctx, { subject: rawSubject, vibes: rawVibes, idempotencyKey: rawKey }) {
    const { db, config, rates } = ctx;
    assertEnabled(config);
    if (!config.vibes || !config.vibes.fromBalance) fail(404, 'billing.vibes_from_balance_disabled', 'Get Vibes with Balance is not open');
    await assertNotFrozen(db);
    const subject = userSubject(rawSubject, 'subject');
    const vibes = positiveInt(rawVibes, 'vibes', rates.maxBits);
    if (vibes < rates.minPurchaseBits) fail(422, 'billing.amount_too_small', `the minimum is ${rates.minPurchaseBits} Vibes`);
    const bitsPerUsd = Number(rates.bitsPerUsd);
    if (!Number.isInteger(bitsPerUsd) || bitsPerUsd <= 0) fail(503, 'billing.rates_unavailable', 'the Vibes rate is not configured');
    const price = (BigInt(vibes) * NANO_PER_USD + BigInt(bitsPerUsd) - 1n) / BigInt(bitsPerUsd);
    const key = idempotencyKey(rawKey);

    return await money(db, async () => {
        const now = ctx.now();
        const nowIso = iso(now);
        const check = async () => {
            const row = await db.prepare('SELECT *, vibes::text AS vibes_text, price_nano_usd::text AS price_text FROM vibes_from_balance WHERE idempotency_key = ?').get(key);
            if (!row) return null;
            if (row.subject !== subject || BigInt(row.vibes_text) !== BigInt(vibes)) {
                fail(409, 'billing.idempotency_key_reused', 'the same idempotency_key was used for another Vibes purchase');
            }
            return row;
        };
        const first = await check();
        if (first) return await vibesResult(ctx, first, subject, vibes, BigInt(first.price_text), BigInt(first.bits_per_usd), true);

        const fromId = await requireBalanceAccount(db, subject, null, nowIso);
        const raced = await check();
        if (raced) return await vibesResult(ctx, raced, subject, vibes, BigInt(raced.price_text), BigInt(raced.bits_per_usd), true);

        const available = BigInt(String(await availableOf(db, fromId)));
        if (available < price) fail(402, 'billing.insufficient_funds', `insufficient Balance: ${available} < ${price} nano-USD for ${vibes} Vibes`, { available: String(available), required: String(price) });
        const { txn } = await post(ctx, {
            type: 'purchase', idempotencyKey: `balance:vibes:${key}`, actor: { type: 'user', id: subject },
            fromSubject: subject, toSubject: subject, provider: 'balance',
            entries: [
                entry(A_INF.credit(subject, null), -price),
                entry(A_INF.revenue(), price),
                entry(A.fxBits(), -vibes),
                entry(A.credit(subject), vibes),
            ],
            metadata: { balance: 'vibes_from_balance', idempotency_key: key, vibes, price_nano_usd: String(price), bits_per_usd: bitsPerUsd },
        });
        const row = await db.prepare(`INSERT INTO vibes_from_balance (id, idempotency_key, subject, vibes, price_nano_usd, bits_per_usd, journal_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?::timestamptz) RETURNING *, vibes::text AS vibes_text, price_nano_usd::text AS price_text`)
            .get(prefixedId('vfb', now), key, subject, vibes, price, bitsPerUsd, txn.id, nowIso);
        return await vibesResult(ctx, row, subject, vibes, price, BigInt(bitsPerUsd), false);
    });
}

async function vibesResult(ctx, row, subject, vibes, price, bitsPerUsd, replay) {
    return {
        purchase_id: row.id,
        transaction_id: row.journal_id,
        replay,
        vibes: Number(vibes),
        price_nano_usd: String(price),
        bits_per_usd: Number(bitsPerUsd),
        balance: await presentBalance(ctx, subject),
        vibes_credit: await balance(ctx.db, A.credit(subject)),
    };
}

module.exports = { readBalance, presentBalance, transfer, buyVibes, assertProjectAdmin, idempotencyKey, availableOf };
