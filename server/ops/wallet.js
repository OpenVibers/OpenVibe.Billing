'use strict';

const { balance } = require('../ledger');
const { A, fail } = require('./common');
const { presentBalance } = require('./balance');
const { activity } = require('./activity');
const money = require('../money/reasons');

const QUEST_TTL_MS = 10 * 60_000;
let questCache = { at: 0, names: new Map() };

/**
 * Quest ids → their own names and addresses, from Quest's public catalog (the declaration in
 * billing.money-reason@1 names this URL). Best-effort and cached: without it a slug still names the
 * quest ("for the quest Publish a video") and the address is still built from the id.
 */
async function questNames(ctx) {
    if (questCache.at && Date.now() - questCache.at < QUEST_TTL_MS) return questCache.names;
    const base = String(ctx.config.quests && ctx.config.quests.url || 'https://openvibe.quest').replace(/\/+$/, '');
    const names = new Map();
    try {
        const r = await ctx.fetchImpl(`${base}/api/v1/quests`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2500) });
        if (r.ok) {
            const body = await r.json();
            for (const site of (body && Array.isArray(body.sites) ? body.sites : [])) {
                for (const q of (Array.isArray(site.quests) ? site.quests : [])) {
                    if (!q || !q.id) continue;
                    names.set(String(q.id), { name: String(q.title || q.id).slice(0, 160), url: `${base}${String(q.url || `/quests/${encodeURIComponent(q.id)}`)}` });
                }
            }
        }
    } catch { /* the slug and the id still answer */ }
    questCache = { at: Date.now(), names };
    return names;
}

// Network remains authoritative for OpenCoins. Never request with=vibes here: that asks Billing again.
async function coinsRead(ctx, authorization, path) {
    try {
        const r = await ctx.fetchImpl(`${ctx.config.network.internalUrl}/api/coins/me${path}`, {
            headers: { Authorization: authorization, Accept: 'application/json' },
            credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error('Network refused the wallet read');
        return await r.json();
    } catch {
        fail(502, 'billing.coins_unavailable', 'OpenCoins is temporarily unavailable; try again');
    }
}

async function wallet(ctx, subject, authorization) {
    if (ctx.config.authority !== 'billing') fail(409, 'billing.not_authoritative', 'Billing is not the active ledger');
    const [coins, history, vibes, personal, recent, frozen, ai] = await Promise.all([
        coinsRead(ctx, authorization, ''), coinsRead(ctx, authorization, '/history?limit=5&offset=0'),
        balance(ctx.db, A.credit(subject)), presentBalance(ctx, subject), activity(ctx, subject, { limit: 5 }),
        require('./wallet-freeze').walletFrozen(ctx),
        ctx.db.prepare(`SELECT 1 AS used FROM credit_settlements s JOIN credit_holds h ON h.id = s.hold_id
            WHERE s.subject = ? AND h.service = 'ai' AND s.created_at >= ? LIMIT 1`)
            .get(subject, new Date(new Date(ctx.now()).toISOString().slice(0, 7) + '-01T00:00:00Z').toISOString()),
    ]);
    if (!Number.isSafeInteger(coins.balance) || coins.balance < 0 || !Array.isArray(history.transactions)) {
        fail(502, 'billing.coins_unavailable', 'Network returned an invalid OpenCoins wallet');
    }
    const events = recent.activity.map((e) => ({ ...e, amount: String(e.amount), site: 'billing' }));
    const ids = [...new Set(events.map((e) => e.id))];
    if (ids.length) {
        const rows = await ctx.db.prepare(`SELECT id, metadata FROM transactions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        for (const row of rows) {
            const m = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata || {};
            const site = String(m.site || m.service || m.app_name || (m.credit === 'settle' ? 'ai' : 'billing')).slice(0, 80);
            for (const e of events) if (e.id === row.id) e.site = site;
        }
    }
    const quests = history.transactions.some((e) => /^quest:/.test(String(e.reason || ''))) ? await questNames(ctx) : new Map();
    for (const e of history.transactions) {
        if (!Number.isSafeInteger(Number(e.delta)) || !Number.isFinite(Date.parse(e.created_at))) {
            fail(502, 'billing.coins_unavailable', 'Network returned invalid OpenCoins activity');
        }
        const d = money.describe(e.reason, { site: e.app_id || 'network', resolve: { quest: (id) => quests.get(id) } });
        events.push({ id: `coins:${e.id}`, at: new Date(e.created_at).toISOString(), kind: 'coins',
            amount: String(e.delta), label: d.text, subject: d.subject, reason_key: d.key, detail: '', site: d.site });
    }
    events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
    return {
        subject: { type: 'user', id: subject }, currency: 'USD', money_writes_frozen: frozen, used_ai_this_month: !!ai,
        balances: {
            coins: { label: 'OpenCoins', amount: String(coins.balance), currency: 'opencoins', scale: 0,
                purpose: 'Earned by taking part; spend on items across OpenVibe.', action: 'How to earn OpenCoins' },
            vibes: { label: 'Vibes', amount: String(vibes), currency: 'vibes-bits', scale: 0,
                purpose: 'Support creators and buy items across OpenVibe.', action: 'Buy Vibes' },
            balance: { label: 'Balance', amount: personal.available_nano_usd, currency: 'USD', scale: 9,
                held: personal.held_nano_usd, purpose: 'Real money for AI and paid features.', action: 'Top up' },
        },
        bits_per_usd: ctx.rates.bitsPerUsd, recent_activity: events.slice(0, 5),
    };
}

module.exports = { wallet };
