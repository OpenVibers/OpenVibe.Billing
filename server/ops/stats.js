'use strict';

/**
 * Network-wide money counts with no person in them (openvibe-contracts 0.203.0, billing.stats.read, GET /api/v1/stats),
 * for a product's public stats: OpenVibe.Live's home counted Vibes bought and channel subscriptions from its own tables,
 * which stopped at the cutover of 2026-10-17.
 *
 *   purchases       Vibes bought with money: the credit settled purchase transactions put in buyers' accounts,
 *                   test rows left out. bits_total is all time; the balances imported from Live at the cutover are
 *                   'import' transactions, not purchases, so they count in neither the total nor the windows and series
 *                   (Live itself had settled one PowerChat order before the cutover).
 *   subscriptions   active now (status active, period not over); started = paid first periods (renewals are not new
 *                   subscriptions), windows and daily series, test and imported rows left out.
 *
 * Windows: d, w, m = the last 1, 7 and 30 days; pw = the 7 days before the last 7. Days are UTC.
 */
const { iso } = require('../ledger');

const DAY = 86_400_000;

function windowsOf(rows, now) {
    const since = (ms) => iso(now - ms);
    const sum = (from, to = null) => rows.filter((r) => r.at >= from && (to == null || r.at < to)).reduce((a, r) => a + r.value, 0);
    return { d: sum(since(DAY)), w: sum(since(7 * DAY)), m: sum(since(30 * DAY)), pw: sum(since(14 * DAY), since(7 * DAY)) };
}

function seriesOf(rows, now, days) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) out.push({ day: iso(now - i * DAY).slice(0, 10), value: 0 });
    const byDay = new Map(out.map((x) => [x.day, x]));
    for (const r of rows) { const b = byDay.get(r.at.slice(0, 10)); if (b) b.value += r.value; }
    return out;
}

async function stats(ctx, { days = 30 } = {}) {
    const { db } = ctx;
    const now = ctx.now();
    const n = Math.min(90, Math.max(1, Math.round(Number(days)) || 30));
    const since = iso(now - Math.max(n, 30) * DAY);

    const total = await db.prepare(`SELECT COALESCE(SUM(e.amount), 0)::bigint AS bits FROM transactions t
        JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
        WHERE t.type = 'purchase' AND t.test = 0 AND a.kind = 'user_credit' AND e.amount > 0`).get();
    const purchases = (await db.prepare(`SELECT t.created_at AS at, SUM(e.amount)::bigint AS value FROM transactions t
        JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
        WHERE t.type = 'purchase' AND t.test = 0 AND t.status = 'settled' AND a.kind = 'user_credit' AND e.amount > 0 AND t.created_at >= ?
        GROUP BY t.id, t.created_at`).all(since)).map((r) => ({ at: r.at, value: Number(r.value) }));

    const active = await db.prepare("SELECT COUNT(*)::bigint AS n FROM subscriptions WHERE status = 'active' AND current_period_end > ?").get(iso(now));
    const started = (await db.prepare(`SELECT created_at AS at, metadata FROM transactions
        WHERE type = 'subscription' AND test = 0 AND status = 'settled' AND created_at >= ?`).all(since))
        .filter((r) => { try { return JSON.parse(r.metadata || '{}').renewal !== true; } catch { return true; } })
        .map((r) => ({ at: r.at, value: 1 }));

    return {
        as_of: iso(now),
        purchases: { bits_total: Number(total.bits), windows: windowsOf(purchases, now), series: seriesOf(purchases, now, n) },
        subscriptions: { active: Number(active.n), windows: windowsOf(started, now), series: seriesOf(started, now, n) },
    };
}

module.exports = { stats };
