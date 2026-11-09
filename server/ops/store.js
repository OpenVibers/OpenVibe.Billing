'use strict';

const { serviceAuth } = require('openvibe-contracts');
const { A, entry, fail, assertNotFrozen } = require('./common');
const { money, post, requireFunds } = require('../ledger');
const { enqueue } = require('../outbox');
const { summary } = require('./purchases');

function createStoreSpender(ctx) {
    const tokens = serviceAuth.createTokenClient({ tokenUrl: `${ctx.config.network.internalUrl}/oauth/token`,
        clientId: ctx.config.oauth.clientId, clientSecret: ctx.config.oauth.clientSecret, audience: 'openvibe.network',
        scope: 'network.coins.debit', fetchImpl: ctx.fetchImpl });
    const present = (p) => ({ purchase_id: p.purchase_id, payment_id: p.payment_id, currency: p.currency, amount: Number(p.amount) });
    async function spend(subject, networkUserId, authorization, id) {
        if (!/^isp_[0-9A-HJKMNP-TV-Z]{26}$/.test(id || '')) fail(422, 'billing.invalid_purchase', 'purchase_id is required');
        let saved = await ctx.db.prepare('SELECT * FROM wallet_store_payments WHERE purchase_id = ?').get(id);
        if (saved && saved.subject !== subject) fail(404, 'billing.purchase_not_found', 'No such purchase');
        if (saved && saved.payment_id) return present(saved);
        if (ctx.config.authority !== 'billing') fail(409, 'billing.not_authoritative', 'Billing is not the active ledger');
        await assertNotFrozen(ctx);
        if (!saved) {
            let quote;
            try {
                const r = await ctx.fetchImpl(`${ctx.config.inventoryUrl}/api/v1/store/purchases/${id}`, {
                    headers: { Authorization: authorization }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) });
                if (!r.ok) throw new Error('No quote');
                quote = await r.json();
            } catch { fail(502, 'billing.inventory_unavailable', 'Could not verify the store order'); }
            if (quote.id !== id || quote.subject !== subject || !['coins', 'vibes'].includes(quote.currency) ||
                !Number.isSafeInteger(quote.amount) || quote.amount < 1 || quote.amount > ctx.rates.maxBits ||
                !/^itd_[0-9A-HJKMNP-TV-Z]{26}$/.test(quote.item_id || '') || typeof quote.name !== 'string') {
                fail(422, 'billing.invalid_purchase', 'Inventory returned an invalid order');
            }
            await ctx.db.prepare(`INSERT INTO wallet_store_payments (purchase_id, subject, currency, amount, item_id, name, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
                .run(id, subject, quote.currency, quote.amount, quote.item_id, quote.name.slice(0, 120), new Date(ctx.now()).toISOString());
            saved = await ctx.db.prepare('SELECT * FROM wallet_store_payments WHERE purchase_id = ?').get(id);
            if (saved.subject !== subject) fail(404, 'billing.purchase_not_found', 'No such purchase');
        }
        if (saved.currency === 'vibes') {
            return money(ctx.db, async () => {
                await assertNotFrozen(ctx);
                const row = await ctx.db.prepare('SELECT * FROM wallet_store_payments WHERE purchase_id = ? FOR UPDATE').get(id);
                if (row.payment_id) return present(row);
                const amount = Number(row.amount);
                await requireFunds(ctx.db, A.credit(subject), amount, 'Vibes');
                const { txn } = await post(ctx, { type: 'purchase', idempotencyKey: `store:${id}`, fromSubject: subject,
                    actor: { type: 'user', id: subject }, entries: [entry(A.credit(subject), -amount), entry(A.revenue('vibes-bits'), amount)],
                    metadata: { store_purchase: id, item_id: row.item_id, item_name: row.name, site: 'inventory', amount_bits: amount } });
                await ctx.db.prepare('UPDATE wallet_store_payments SET payment_id = ? WHERE purchase_id = ?').run(txn.id, id);
                await enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn) });
                return present({ ...row, payment_id: txn.id });
            });
        }
        if (!Number.isSafeInteger(Number(networkUserId)) || Number(networkUserId) < 1) fail(401, 'token.invalid', 'The token has no Network user id');
        // The debit stays in Network's ledger. The durable order and deterministic key recover an uncertain response.
        let r, data;
        try {
            r = await ctx.fetchImpl(`${ctx.config.network.internalUrl}/internal/coins/debit`, { method: 'POST',
                headers: { ...(await tokens.authHeaders()), 'Content-Type': 'application/json' },
                credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000),
                body: JSON.stringify({ user_id: Number(networkUserId), app_id: 'billing', amount: Number(saved.amount),
                    reason: `Bought ${saved.name} at Inventory`, ref: id, idempotency_key: `billing-store:${id}` }) });
            data = await r.json();
        } catch { fail(504, 'billing.payment_unknown', 'Retry this purchase to recover its original payment'); }
        if (!r.ok) {
            if (r.status === 409 && data.error === 'insufficient_funds') fail(402, 'billing.insufficient_funds', 'Not enough OpenCoins');
            fail(502, 'billing.coins_unavailable', 'OpenCoins payment is unavailable; retry this purchase');
        }
        if (!Number.isSafeInteger(data.balance) || data.balance < 0) fail(502, 'billing.payment_unknown', 'Invalid OpenCoins confirmation; retry this purchase');
        const paymentId = `coins:${id}`;
        await ctx.db.prepare('UPDATE wallet_store_payments SET payment_id = ? WHERE purchase_id = ?').run(paymentId, id);
        return present({ ...saved, payment_id: paymentId });
    }
    return { spend };
}

module.exports = { createStoreSpender };
