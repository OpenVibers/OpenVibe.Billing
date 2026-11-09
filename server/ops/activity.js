'use strict';

/**
 * A person's own activity (D12, Network's /wallet): one row per currency part of every journal transaction that
 * touched their Balance (`usd_credit`, user:<usr_id>) or their spendable Vibes (`user_credit`). A transaction that
 * moved both (Get Vibes with Balance) has two rows with the same id, so the wallet can group them.
 *
 * Labels are the public words: Added money, AI usage, Got Vibes, Tipped @name, Paid <app>, Moved to <project>,
 * Refund. Only a creator's public name is read from Network; no other subject id, email or project secret is in a
 * row. Balance amounts are signed nano-USD decimal strings; Vibes are signed whole integers.
 */
const { fail, userSubject } = require('./common');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const PROVIDERS = { stripe: 'Stripe', paypal: 'PayPal', ccbill: 'CCBill', nowpayments: 'NOWPayments', powerchat: 'PowerChat' };
const APP_NAME_MAX = 80;

function parseJson(v) {
    if (v == null) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v) || {}; } catch { return {}; }
}

function titleCase(s) {
    return String(s || '').replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}

/** The model in a settlement attempt's deployment_id: "<provider>:<model>". */
function modelOf(attempt) {
    if (!attempt || typeof attempt.deployment_id !== 'string') return null;
    const i = attempt.deployment_id.indexOf(':');
    const model = i >= 0 ? attempt.deployment_id.slice(i + 1) : '';
    return model ? model.slice(0, 120) : null;
}

function labelFor(t, { settlement, projectName, creatorName }) {
    const m = parseJson(t.metadata);
    if (t.type === 'credit' && m.credit === 'settle') {
        const attempts = settlement && Array.isArray(settlement.attempts) ? settlement.attempts : [];
        const model = modelOf(attempts[attempts.length - 1]);
        const requests = attempts.length || 1;
        return { label: 'AI usage', detail: [model, `${requests} request${requests === 1 ? '' : 's'}`].filter(Boolean).join(' · ') };
    }
    if (t.type === 'credit' && m.credit === 'topup') {
        const provider = PROVIDERS[String(t.provider || m.provider || '').toLowerCase()] || titleCase(t.provider || m.provider || '');
        return { label: 'Added money', detail: provider };
    }
    if (t.type === 'purchase' && m.balance === 'vibes_from_balance') {
        const n = Number(m.vibes || 0);
        return { label: 'Got Vibes', detail: n ? `${n} Vibes` : '' };
    }
    if ((t.type === 'purchase' && (m.vibes_charge || m.vibes_charge_id || m.charge === 'vibes_pay' || m.app_name)) || t.type === 'vibes_charge') {
        const app = m.app_name || (m.app && typeof m.app === 'object' ? m.app.name : null) || (m.app && typeof m.app !== 'object' ? m.app : null);
        const name = app ? String(app).slice(0, APP_NAME_MAX) : null;
        return { label: name ? `Paid ${name}` : 'Paid an app', detail: m.description ? String(m.description).slice(0, 120) : '' };
    }
    if (t.type === 'purchase' && m.store_purchase) return { label: `Bought ${String(m.item_name || 'an item').slice(0, 120)}`, detail: 'Inventory' };
    if (t.type === 'purchase') {
        const n = Number(m.bits || m.vibes || m.amount_bits || 0);
        return { label: 'Got Vibes', detail: n ? `${n} Vibes` : '' };
    }
    if (t.type === 'balance_transfer') {
        return { label: projectName ? `Moved to ${projectName}` : 'Moved to a project', detail: '' };
    }
    if (t.type === 'donation') {
        return { label: creatorName ? `Tipped @${creatorName}` : 'Tipped a creator', detail: '' };
    }
    if (t.type === 'refund' || t.type === 'vibes_refund') return { label: 'Refund', detail: 'Returned' };
    if (t.type === 'cashout_request' || t.type === 'cashout_paid') return { label: 'Cash out', detail: 'Payable' };
    return { label: titleCase(t.type) || 'Activity', detail: '' };
}

/**
 * GET /api/me/activity. `before` is the id of the last transaction on the previous page; the answer carries rows
 * (newest first) and `next_before` when more exist.
 */
async function activity(ctx, rawSubject, { limit = DEFAULT_LIMIT, before = null } = {}) {
    const db = ctx.db;
    const subject = userSubject(rawSubject, 'subject');
    const n = Number(limit);
    const take = Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;

    let cursor = null;
    if (before != null && before !== '') {
        const id = String(before);
        if (!/^txn_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) fail(422, 'billing.invalid_cursor', 'before must be a transaction id from this list');
        cursor = await db.prepare('SELECT id, created_at FROM transactions WHERE id = ?').get(id);
        if (!cursor) fail(422, 'billing.invalid_cursor', 'before names no transaction');
    }

    const touch = `((a.kind = 'usd_credit' AND a.currency = 'nano-usd' AND a.owner_subject = ?)
        OR (a.kind = 'user_credit' AND a.currency = 'vibes-bits' AND a.owner_subject = ?))`;
    const args = [`user:${subject}`, subject];
    let where = `WHERE ${touch}`;
    if (cursor) {
        where += ' AND (t.created_at::timestamptz, t.id) < (?::timestamptz, ?)';
        args.push(cursor.created_at, cursor.id);
    }
    const txns = await db.prepare(`SELECT DISTINCT t.id, t.created_at FROM transactions t
        JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
        ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`).all(...args, take + 1);
    const page = txns.slice(0, take);
    const more = txns.length > take;
    if (!page.length) return { activity: [], next_before: null };

    const ids = page.map((t) => t.id);
    const holes = ids.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT t.id, t.type, t.created_at, t.metadata, t.provider, t.to_subject,
            a.kind AS account_kind, e.amount::text AS amount
        FROM transactions t JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id
        WHERE t.id IN (${holes}) AND ${touch}
        ORDER BY t.created_at DESC, t.id DESC, a.kind`).all(...ids, `user:${subject}`, subject);
    const settlements = await db.prepare(`SELECT journal_id, attempts FROM credit_settlements WHERE journal_id IN (${holes})`).all(...ids);
    const settlementOf = new Map(settlements.map((s) => [s.journal_id, { attempts: parseJson(s.attempts) }]));

    // Public names for the creators a tip names, and the person's project names for a transfer. Both are best-effort:
    // a Network hiccup must not hide the person's own movements.
    const donationTargets = [...new Set(rows.filter((r) => r.type === 'donation' && r.to_subject).map((r) => r.to_subject))];
    const names = new Map();
    if (donationTargets.length && ctx.network && typeof ctx.network.profiles === 'function') {
        try { for (const [k, v] of await ctx.network.profiles(donationTargets)) names.set(k, v); } catch { /* fall back to "a creator" */ }
    }
    const projects = new Map();
    if (rows.some((r) => r.type === 'balance_transfer') && ctx.projects && typeof ctx.projects.administered === 'function') {
        try { for (const p of await ctx.projects.administered(subject)) projects.set(p.project_id, p.name); } catch { /* fall back to "a project" */ }
    }

    const byTxn = new Map();
    for (const r of rows) {
        const cur = byTxn.get(r.id) || { txn: r, nano: 0n, vibes: 0 };
        if (r.account_kind === 'usd_credit') cur.nano += BigInt(String(r.amount));
        else cur.vibes += Number(r.amount);
        byTxn.set(r.id, cur);
    }

    const out = [];
    for (const t of page) {
        const cur = byTxn.get(t.id);
        if (!cur) continue;
        const meta = parseJson(cur.txn.metadata);
        let projectName = null;
        if (cur.txn.type === 'balance_transfer') projectName = projects.get(meta.to_project_id) || null;
        const creator = names.get(cur.txn.to_subject);
        const d = labelFor(cur.txn, { settlement: settlementOf.get(t.id), projectName, creatorName: creator && creator.username ? creator.username : null });
        if (cur.nano !== 0n) out.push({ id: t.id, at: t.created_at, kind: 'balance', label: d.label, detail: d.detail, amount: cur.nano.toString() });
        if (cur.vibes !== 0) out.push({ id: t.id, at: t.created_at, kind: 'vibes', label: d.label, detail: d.detail, amount: cur.vibes });
    }
    return { activity: out, next_before: more ? page[page.length - 1].id : null };
}

module.exports = { activity, labelFor };
