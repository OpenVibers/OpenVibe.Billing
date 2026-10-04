'use strict';

/**
 * The promo ledger (plan T5 ledger 2): a recurring, non-transferable free allowance, kept in the journal under its own
 * account kinds so it can never become MONEY.
 *
 *   grant()      promo_reserve → promo_credit:<subject>   (admin only; tops up the allowance of the current window)
 *   consume()    promo_credit:<subject> → promo_reserve   (rating draws the allowance down; keyed by the caller)
 *   lapse        promo_credit:<subject> → promo_reserve   (a window that ended returns what was left unused)
 *
 * transfers.create reads A.credit (user_credit) and cashouts read A.payable (creator_payable) only, so a promo bit has
 * no path to creator_payable; admin adjustments refuse to pair a promo account with any other kind. promo_allowances
 * is the policy and window record; the promo_credit balance is the authoritative remainder: every write here changes
 * both in one transaction, and reconciliation checks that no transaction mixes promo and other accounts.
 */
const { post, balance, getTxnByKey, iso, money } = require('../ledger');
const { A, entry, fail, positiveInt, text, userSubject } = require('./common');

const PERIODS = ['day', 'month', 'none'];
const MAX_GRANT_BITS = 1_000_000_000;
const ACTOR = { type: 'service', id: 'billing' };
const NEVER = '9999-12-31T23:59:59.999Z';

/** The [start, end) window of `period` that covers `at` (ms), as ISO strings; 'none' is one window for all time. */
function windowOf(period, at) {
    const d = new Date(at);
    if (period === 'none') return { start: iso(0), end: NEVER }; // the last ISO-8601 instant PostgreSQL parses back
    if (period === 'day') {
        const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        return { start: iso(s), end: iso(s + 86_400_000) };
    }
    return { start: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), end: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) };
}

const serviceOf = (v) => text(v, 'service', 100) || '*';
const inTx = (db, fn) => (db.inTransaction() ? fn() : money(db, fn));
const open = (r) => Number(r.granted_bits) - Number(r.used_bits) - Number(r.expired_bits);

function present(r) {
    if (!r) return null;
    return {
        id: Number(r.id), subject: { type: 'user', id: r.subject }, service: r.service, reset_period: r.reset_period,
        granted_bits: Number(r.granted_bits), used_bits: Number(r.used_bits), expired_bits: Number(r.expired_bits), remaining_bits: open(r),
        window_start: new Date(r.window_start).toISOString(), window_end: new Date(r.window_end).toISOString(),
    };
}

/** Return what windows that have ended left unused to promo_reserve (once per allowance). Inside the caller's transaction. */
async function lapse(ctx, subject) {
    const { db } = ctx;
    const now = iso(ctx.now());
    const ended = await db.prepare(`SELECT * FROM promo_allowances WHERE subject = ? AND window_end <= ?::timestamptz
        AND used_bits + expired_bits < granted_bits ORDER BY window_end, id`).all(subject, now);
    for (const r of ended) {
        const left = open(r);
        await db.prepare('UPDATE promo_allowances SET expired_bits = expired_bits + ?, updated_at = ?::timestamptz WHERE id = ?').run(left, now, r.id);
        // An out-of-band correction may already have taken some of it: never drive promo_credit below zero.
        const bits = Math.min(left, Math.max(0, await balance(db, A.promo(subject))));
        if (bits > 0) {
            await post(ctx, {
                type: 'adjustment', idempotencyKey: `promo:lapse:${r.id}`, actor: ACTOR, fromSubject: subject,
                entries: [entry(A.promo(subject), -bits), entry(A.promoReserve(), bits)],
                metadata: { promo: 'lapse', allowance_id: Number(r.id), service: r.service, amount_bits: bits },
            });
        }
    }
}

/**
 * Grant `bits` of promo allowance to `subject` for the current `period` window of `service`; a second grant in the
 * same window adds to it. Idempotent by the caller's key (the admin request's Idempotency-Key): a replay moves nothing.
 */
async function grant(ctx, input) {
    const { db } = ctx;
    if (!input.idempotencyKey) fail(422, 'billing.invalid_input', 'a promo grant needs an idempotency key');
    const subject = userSubject(input.subject);
    const service = serviceOf(input.service);
    const period = input.period == null ? 'month' : input.period;
    if (!PERIODS.includes(period)) fail(422, 'billing.invalid_input', `period must be one of ${PERIODS.join(', ')}`);
    const amount = positiveInt(input.bits, 'bits', MAX_GRANT_BITS);
    const key = `promo:grant:${input.idempotencyKey}`;
    return await inTx(db, async () => {
        const existing = await getTxnByKey(db, key);
        if (existing) {
            const row = await db.prepare('SELECT * FROM promo_allowances WHERE id = ?').get(existing.metadata.allowance_id);
            return { allowance: present(row), txn: existing, replay: true };
        }
        await lapse(ctx, subject);
        const now = iso(ctx.now());
        const { start, end } = windowOf(period, ctx.now());
        const row = await db.prepare(`INSERT INTO promo_allowances (subject, service, reset_period, granted_bits, window_start, window_end, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz, ?::timestamptz)
            ON CONFLICT (subject, service, reset_period, window_start)
            DO UPDATE SET granted_bits = promo_allowances.granted_bits + excluded.granted_bits, updated_at = excluded.updated_at
            RETURNING *`).get(subject, service, period, amount, start, end, now, now);
        if (Number(row.granted_bits) > Number.MAX_SAFE_INTEGER) fail(422, 'billing.amount_overflow', 'the allowance would leave the exact integer range');
        const { txn } = await post(ctx, {
            type: 'adjustment', idempotencyKey: key, actor: input.actor || ACTOR, toSubject: subject,
            entries: [entry(A.promoReserve(), -amount), entry(A.promo(subject), amount)],
            metadata: { promo: 'grant', allowance_id: Number(row.id), service, period, window_start: start, window_end: end, amount_bits: amount },
        });
        return { allowance: present(row), txn, replay: false };
    });
}

/**
 * Unused promo bits `subject` may spend on `service` now (on any service when `service` is omitted): the open windows,
 * never more than the promo_credit balance. Reads only, so a window that ended counts 0 before lapse() books it.
 */
async function remaining(ctx, subject, service) {
    const { db } = ctx;
    const now = iso(ctx.now());
    const scoped = service !== undefined;
    const r = await db.prepare(`SELECT COALESCE(SUM(granted_bits - used_bits - expired_bits), 0)::bigint AS bits FROM promo_allowances
        WHERE subject = ? ${scoped ? "AND service IN (?, '*')" : ''} AND window_start <= ?::timestamptz AND window_end > ?::timestamptz`)
        .get(...(scoped ? [subject, serviceOf(service), now, now] : [subject, now, now]));
    return Math.max(0, Math.min(Number(r.bits), await balance(db, A.promo(subject))));
}

/**
 * Draw up to `bits` of `subject`'s allowance for `service` (soonest-ending window first) → { bits: consumed, txn, replay }.
 * The key must come from the caller (e.g. the usage reading's idempotency_key): a retry under the same key returns the
 * first draw and consumes nothing more, and the key cannot be reused for another subject or service (409). A call that
 * finds nothing to draw records nothing, so its key stays unused: the caller's own record (the rated reading, itself
 * keyed) is what stops a replay from asking again. Runs inside the caller's transaction when there is one (rating),
 * else in its own.
 */
async function consume(ctx, input) {
    const { db } = ctx;
    if (!input.idempotencyKey) fail(422, 'billing.invalid_input', 'promo consume needs the caller\'s idempotency key');
    const subject = userSubject(input.subject);
    const service = serviceOf(input.service);
    const wanted = positiveInt(input.bits, 'bits');
    const key = `promo:consume:${input.idempotencyKey}`;
    return await inTx(db, async () => {
        const existing = await getTxnByKey(db, key);
        if (existing) {
            if (existing.metadata.subject !== subject || existing.metadata.service !== service) {
                fail(409, 'billing.promo_key_reused', `another draw is already recorded under ${input.idempotencyKey}`);
            }
            return { bits: existing.metadata.amount_bits, txn: existing, replay: true };
        }
        await lapse(ctx, subject);
        const now = iso(ctx.now());
        let left = Math.min(wanted, Math.max(0, await balance(db, A.promo(subject))));
        const rows = await db.prepare(`SELECT * FROM promo_allowances WHERE subject = ? AND service IN (?, '*')
            AND used_bits + expired_bits < granted_bits AND window_start <= ?::timestamptz AND window_end > ?::timestamptz
            ORDER BY window_end, id`).all(subject, service, now, now);
        const drawn = [];
        for (const r of rows) {
            if (left === 0) break;
            const take = Math.min(left, open(r));
            await db.prepare('UPDATE promo_allowances SET used_bits = used_bits + ?, updated_at = ?::timestamptz WHERE id = ?').run(take, now, r.id);
            drawn.push({ allowance_id: Number(r.id), bits: take });
            left -= take;
        }
        const used = drawn.reduce((s, d) => s + d.bits, 0);
        if (!used) return { bits: 0, txn: null, replay: false };
        const { txn } = await post(ctx, {
            type: 'adjustment', idempotencyKey: key, actor: input.actor || ACTOR, fromSubject: subject,
            entries: [entry(A.promo(subject), -used), entry(A.promoReserve(), used)],
            metadata: { promo: 'consume', subject, service, requested_bits: wanted, amount_bits: used, allowances: drawn },
        });
        return { bits: used, txn, replay: false };
    });
}

module.exports = { grant, consume, remaining, lapse, windowOf, present, PERIODS };
