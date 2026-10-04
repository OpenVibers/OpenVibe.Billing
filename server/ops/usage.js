'use strict';

/**
 * Usage readings (platform.usage-sample@1, plan T5 lane F): a service reports what was used — by which project and
 * subject, on which provider, how much, and, once rated, the free allowance it consumed and the Vibes charged — and
 * Billing keeps it. Storing a reading charges nothing and moves no balance: `vibes_charged` records a charge already
 * made in the ledger, it is never a request to make one. Billing rates stored readings later, in its own background sweep
 * (ops/rating.js); the reading's own free_allowance_used/vibes_charged are kept as sent and never drive a charge.
 *
 * Idempotent by the reading's own idempotency_key (the contract's dedupe key, stable across retries, unique across
 * every caller): the first reading under a key is stored; the same reading again returns the stored row (replay);
 * a different reading under the same key is refused (409 billing.usage_key_reused) and the stored one is kept.
 * "The same" is the canonical JSON (sorted keys), so key order and whitespace don't matter.
 */
const crypto = require('crypto');
const { validate } = require('openvibe-contracts');
const { stable } = require('../api/idempotency');
const { fail, positiveInt } = require('./common');

const CONTRACT = 'platform.usage-sample@1';
const MAX_PAGE = 500;

const hashOf = (reading) => crypto.createHash('sha256').update(stable(reading)).digest('hex');

function present(row) {
    return {
        id: String(row.id), idempotency_key: row.idempotency_key, project: row.project, subject: row.subject, service: row.service,
        at: row.at, received_at: row.received_at, principal: row.principal,
        reading: typeof row.reading === 'string' ? JSON.parse(row.reading) : row.reading,
        // Billing's own rating (ops/rating.js): vibes_charged is absent until the reading is rated.
        ...(row.rated_at ? {
            rated_at: new Date(row.rated_at).toISOString(), vibes_charged: Number(row.vibes_charged), promo_bits: Number(row.promo_bits),
            free_allowance_used: Number(row.free_allowance_used), txn_id: row.txn_id || null,
        } : {}),
        ...(row.rating_error ? { rating_error: row.rating_error } : {}),
    };
}

/** Store one reading. Returns { record, replayed }. */
async function record(ctx, reading, { principal }) {
    const v = validate('platform.usage-sample@1', reading);
    if (!v.valid) fail(422, 'billing.invalid_input', `not a ${CONTRACT}: ${v.errors.map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`, v.errors);
    const atMs = Date.parse(reading.at);
    if (!Number.isFinite(atMs)) fail(422, 'billing.invalid_input', `at ${reading.at} is not a time Billing can store`);
    if (reading.free_allowance_used != null && reading.free_allowance_used > reading.quantity) {
        fail(422, 'billing.invalid_input', 'free_allowance_used is more than quantity');
    }
    const { db } = ctx;
    const hash = hashOf(reading);
    const row = await db.prepare(`INSERT INTO usage_records (idempotency_key, project, subject, service, at, reading, reading_hash, principal, received_at)
        VALUES (?, ?, ?, ?, ?::timestamptz, ?::jsonb, ?, ?, ?::timestamptz)
        ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`)
        .get(reading.idempotency_key, reading.project || null, reading.subject || null, reading.service, new Date(atMs).toISOString(),
            JSON.stringify(reading), hash, principal, new Date(ctx.now()).toISOString());
    if (row) return { record: present(row), replayed: false };
    const prev = await db.prepare('SELECT * FROM usage_records WHERE idempotency_key = ?').get(reading.idempotency_key);
    if (prev.reading_hash !== hash) {
        fail(409, 'billing.usage_key_reused', `a different reading is already stored under idempotency_key ${reading.idempotency_key}`);
    }
    return { record: present(prev), replayed: true };
}

const time = (v, field) => {
    const ms = Date.parse(String(v));
    if (!Number.isFinite(ms)) fail(422, 'billing.invalid_input', `${field} must be an ISO-8601 date-time`);
    return new Date(ms).toISOString();
};

/**
 * Readings, newest first (by `at`, then id), filtered by any of project, subject, service and the time range
 * from ≤ at < to. Cursor paging: next_cursor continues after the last row of this page, null on the last page.
 */
async function list(db, q = {}) {
    const where = [];
    const args = {};
    for (const f of ['project', 'subject', 'service']) {
        if (q[f] != null && q[f] !== '') { where.push(`${f} = @${f}`); args[f] = String(q[f]); }
    }
    if (q.from) { where.push('at >= @from::timestamptz'); args.from = time(q.from, 'from'); }
    if (q.to) { where.push('at < @to::timestamptz'); args.to = time(q.to, 'to'); }
    if (q.cursor) {
        let cur;
        try { cur = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8')); } catch { /* below */ }
        if (!Array.isArray(cur) || cur.length !== 2 || !Number.isFinite(Date.parse(cur[0])) || !/^\d{1,18}$/.test(String(cur[1]))) fail(422, 'billing.invalid_input', 'bad cursor');
        where.push('(at < @c_at::timestamptz OR (at = @c_at::timestamptz AND id < @c_id::bigint))');
        args.c_at = cur[0]; args.c_id = String(cur[1]);
    }
    const limit = Math.min(MAX_PAGE, positiveInt(q.limit || 100, 'limit'));
    args.n = limit + 1;
    const rows = await db.prepare(`SELECT * FROM usage_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT @n`).all(args);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const next = rows.length > limit ? Buffer.from(JSON.stringify([last.at, String(last.id)])).toString('base64url') : null;
    return { records: page.map(present), next_cursor: next };
}

module.exports = { record, list, present, CONTRACT };
