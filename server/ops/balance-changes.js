'use strict';

/**
 * Ask 273: "what changed in my balances since I last looked", per currency.
 *
 *   changes(ctx, subject, { currency, since, limit })
 *     → { currency, balance, since, moves, parts, net, cursor, next_since, read_cursor }
 *
 * One move per journal transaction that touched the person's accounts of the currency, oldest
 * first: { id, at, delta, part, label, detail, reason_key }. `parts` sums the window's moves into
 * earned / spent / received / sent and `net` is their total — what the bar needs for a gain or a
 * loss with its reason. `since` is a transaction id from an earlier answer; omitted, the person's
 * own stored read state answers ("since I last looked"); with neither, the window starts at the
 * person's first move. `cursor` is the newest move seen (or the head when the window is empty) and
 * `next_since` pages the moves when they overflow the limit; parts and net always cover the whole
 * window. markRead() stores the read state (monotonic: looking backwards is refused).
 *
 * Billing is the only money ledger: every number here is read from the journal, never a second ledger.
 */
const { fail, userSubject, A } = require('./common');
const { balance } = require('../ledger');
const { labelFor } = require('./activity');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const WINDOW_TXN_CAP = 5000;
const TXN_RE = /^txn_[0-9A-HJKMNP-TV-Z]{26}$/;

const TOUCH_VIBES = `((a.kind = 'user_credit' AND a.currency = 'vibes-bits' AND a.owner_subject = ?)
    OR (a.kind = 'creator_payable' AND a.currency = 'vibes-bits' AND a.owner_subject = ?))`;

/**
 * Which part of the change a move is. Incoming creator earnings are earned; anything else arriving
 * (bought Vibes, refunds back to credit) is received. Money leaving for another person or out of
 * the system (a tip, a cashout, a refunded tip) is sent; money consumed (a subscription, an app or
 * store purchase) is spent.
 */
function partOf({ net, type, kinds }) {
    if (net > 0) return kinds.has('creator_payable') ? 'earned' : 'received';
    if (type === 'donation' || type === 'cashout_request' || type === 'cashout_paid' || type === 'refund') return 'sent';
    return 'spent';
}

async function txnById(db, id) {
    if (!TXN_RE.test(String(id || ''))) fail(422, 'billing.invalid_cursor', 'since must be a transaction id from this list');
    const row = await db.prepare('SELECT id, created_at FROM transactions WHERE id = ?').get(String(id));
    if (!row) fail(422, 'billing.invalid_cursor', 'since names no transaction');
    return row;
}

async function readCursor(db, subject, currency) {
    const row = await db.prepare('SELECT last_seen_txn AS cursor FROM balance_reads WHERE subject = ? AND currency = ?').get(subject, currency);
    return row ? row.cursor : null;
}

/** The person's own movements since a cursor, oldest first, with gain/loss parts over the window. */
async function changes(ctx, rawSubject, { currency = 'vibes', since = null, limit = DEFAULT_LIMIT } = {}) {
    const db = ctx.db;
    const subject = userSubject(rawSubject, 'subject');
    if (currency !== 'vibes') fail(422, 'billing.invalid_currency', 'currency is vibes');
    const n = Number(limit);
    const take = Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;

    let start = null;
    if (since != null && since !== '') {
        start = await txnById(db, since);
    } else {
        const stored = await readCursor(db, subject, currency);
        if (stored) start = await txnById(db, stored);
    }

    let where = `WHERE ${TOUCH_VIBES}`;
    const args = [subject, subject];
    if (start) {
        where += ' AND (t.created_at::timestamptz, t.id) > (?::timestamptz, ?)';
        args.push(start.created_at, start.id);
    }
    const ids = await db.prepare(`SELECT DISTINCT t.id FROM transactions t
        JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
        ${where} ORDER BY t.id ASC LIMIT ?`).all(...args, WINDOW_TXN_CAP + 1);
    const truncated = ids.length > WINDOW_TXN_CAP;
    const windowIds = (truncated ? ids.slice(0, WINDOW_TXN_CAP) : ids).map((r) => r.id);
    if (!windowIds.length) {
        const head = await db.prepare(`SELECT t.id FROM transactions t
            JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
            WHERE ${TOUCH_VIBES} ORDER BY t.created_at DESC, t.id DESC LIMIT 1`).get(subject, subject);
        return {
            currency, balance: await current(ctx, subject),
            since: start ? start.id : null, moves: [],
            parts: { earned: 0, spent: 0, received: 0, sent: 0 }, net: 0,
            cursor: head ? head.id : null, next_since: null, read_cursor: await readCursor(db, subject, currency),
        };
    }

    const holes = windowIds.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT t.id, t.type, t.created_at, t.metadata, t.to_subject,
            a.kind AS account_kind, e.amount::text AS amount
        FROM transactions t JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
        WHERE t.id IN (${holes}) AND ${TOUCH_VIBES}
        ORDER BY t.created_at ASC, t.id ASC, a.kind`).all(...windowIds, subject, subject);

    const donationTargets = [...new Set(rows.filter((r) => r.type === 'donation' && r.to_subject).map((r) => r.to_subject))];
    const names = new Map();
    if (donationTargets.length && ctx.network && typeof ctx.network.profiles === 'function') {
        try { for (const [k, v] of await ctx.network.profiles(donationTargets)) names.set(k, v); } catch { /* fall back to "a creator" */ }
    }

    const byTxn = new Map();
    for (const r of rows) {
        const cur = byTxn.get(r.id) || { txn: r, vibes: 0, kinds: new Set() };
        cur.vibes += Number(r.amount);
        cur.kinds.add(r.account_kind);
        byTxn.set(r.id, cur);
    }

    const parts = { earned: 0, spent: 0, received: 0, sent: 0 };
    const moves = [];
    for (const id of windowIds) {
        const cur = byTxn.get(id);
        if (!cur || cur.vibes === 0) continue;
        const creator = names.get(cur.txn.to_subject);
        const d = labelFor(cur.txn, { settlement: undefined, projectName: null, creatorName: creator && creator.username ? creator.username : null });
        const part = partOf({ net: cur.vibes, type: cur.txn.type, kinds: cur.kinds });
        parts[part] += cur.vibes;
        moves.push({
            id, at: cur.txn.created_at, delta: cur.vibes, part,
            label: d.label, detail: d.detail, subject: d.subject, reason_key: d.reason_key,
        });
    }
    const net = parts.earned + parts.spent + parts.received + parts.sent;
    const page = moves.slice(0, take);
    return {
        currency,
        balance: await current(ctx, subject),
        since: start ? start.id : null,
        moves: page,
        parts, net,
        cursor: moves.length ? moves[moves.length - 1].id : (start ? start.id : null),
        next_since: moves.length > take ? page[page.length - 1].id : null,
        read_cursor: await readCursor(db, subject, currency),
        ...(truncated ? { truncated: true } : {}),
    };
}

async function current(ctx, subject) {
    return {
        credit: await balance(ctx.db, A.credit(subject)),
        payable: await balance(ctx.db, A.payable(subject)),
    };
}

/** Store "I looked": the cursor must name a real transaction and may only move forward. */
async function markRead(ctx, rawSubject, { currency = 'vibes', cursor } = {}) {
    const db = ctx.db;
    const subject = userSubject(rawSubject, 'subject');
    if (currency !== 'vibes') fail(422, 'billing.invalid_currency', 'currency is vibes');
    const at = await txnById(db, cursor);
    const stored = await db.prepare('SELECT last_seen_txn AS cursor FROM balance_reads WHERE subject = ? AND currency = ?').get(subject, currency);
    if (stored) {
        const prev = await txnById(db, stored.cursor);
        const back = at.created_at < prev.created_at || (at.created_at === prev.created_at && at.id < prev.id);
        if (back) fail(409, 'billing.stale_read', 'the read cursor only moves forward');
    }
    const now = new Date(ctx.now()).toISOString();
    await db.prepare(`INSERT INTO balance_reads (subject, currency, last_seen_txn, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (subject, currency) DO UPDATE SET last_seen_txn = EXCLUDED.last_seen_txn, updated_at = EXCLUDED.updated_at`)
        .run(subject, currency, at.id, now);
    return { currency, read_cursor: at.id };
}

module.exports = { changes, markRead };
