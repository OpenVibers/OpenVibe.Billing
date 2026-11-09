'use strict';
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, fund, check, done } = require('./helpers/app');
const { createStoreSpender } = require('../server/ops/store');
const { checkout } = require('../server/ops/wallet-checkout');

(async () => {
    const t = await boot({ stripe: true, env: { BILLING_AUTHORITY: 'billing', BILLING_CREDITS: '1',
        BILLING_CREDITS_TOPUP: '1', BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000', BILLING_CREDITS_TOPUP_FEE_BPS: '0' } });
    const alice = t.user(401), bob = t.user(402);
    const token = t.network.signUser({ subject_id: alice.id });
    await fund(t, alice.id, 100);
    const orders = new Map(), debited = new Map();
    let loseResponse = false;
    const realFetch = t.ctx.fetchImpl;
    t.ctx.fetchImpl = async (url, options) => {
        if (url.includes('/store/purchases/')) {
            assert.strictEqual(options.headers.Authorization, `Bearer ${token}`);
            return { ok: true, json: async () => orders.get(url.split('/').pop()) };
        }
        if (url.endsWith('/internal/coins/debit')) {
            const b = JSON.parse(options.body);
            assert.strictEqual(b.user_id, 42); assert.strictEqual(b.app_id, 'billing');
            debited.set(b.idempotency_key, b);
            if (loseResponse) { loseResponse = false; throw new Error('lost payment reply'); }
            return { ok: true, json: async () => ({ balance: 20 }) };
        }
        return realFetch(url, options);
    };
    const spender = createStoreSpender(t.ctx);
    const order = (currency, amount, subject = alice.id) => {
        const id = `isp_${ids.ulid()}`;
        orders.set(id, { id, subject, item_id: `itd_${ids.ulid()}`, name: 'Rainbow', currency, amount }); return id;
    };
    const pay = (id, subject = alice.id) => spender.spend(subject, 42, `Bearer ${token}`, id);
    await check('concurrent Vibes payment retries debit once and cannot exceed available funds', async () => {
        const id = order('vibes', 60);
        const [a, b] = await Promise.all([pay(id), pay(id)]);
        assert.strictEqual(a.payment_id, b.payment_id);
        assert.strictEqual((await t.balances(alice.id)).credit, 40);
        await assert.rejects(pay(order('vibes', 60)), (e) => e.status === 402 || e.code === 'billing.insufficient_funds');
        assert.strictEqual((await t.balances(alice.id)).credit, 40);
        await assert.rejects(pay(id, bob.id), (e) => e.status === 404);
    });
    await check('Network uncertain response retries the exact same debit key and amount', async () => {
        const id = order('coins', 30);
        loseResponse = true;
        await assert.rejects(pay(id), (e) => e.code === 'billing.payment_unknown');
        const result = await pay(id);
        assert.strictEqual(result.amount, 30);
        assert.strictEqual(debited.size, 1);
        assert.strictEqual((await pay(id)).payment_id, result.payment_id);
    });
    await check('untrusted or foreign order snapshots cannot move money', async () => {
        await assert.rejects(pay(order('vibes', 1, bob.id)), (e) => e.code === 'billing.invalid_purchase');
        await assert.rejects(pay(order('vibes', -1)), (e) => e.code === 'billing.invalid_purchase');
        await assert.rejects(pay('https://evil.example'), (e) => e.status === 422);
    });
    await check('bearer Vibes checkout fixes subject and price and replays its provider session', async () => {
        const body = { provider: 'stripe', vibes: 100, idempotency_key: 'checkout-test-01', amount_cents: 1, subject: bob.id };
        const a = await t.call('POST', '/api/v1/me/vibes/buy', { token, body });
        assert.strictEqual(a.status, 200, a.text);
        assert.strictEqual(a.json.intent.subject.id, alice.id);
        assert.strictEqual(a.json.intent.amount_cents, t.ctx.rates.priceCents(100));
        const before = t.stripe.calls.length;
        const b = await t.call('POST', '/api/v1/me/vibes/buy', { token, body });
        assert.deepStrictEqual(b.json, a.json); assert.strictEqual(t.stripe.calls.length, before);
        const c = await t.call('POST', '/api/v1/me/vibes/buy', { token, body: { ...body, vibes: 200 } });
        assert.strictEqual(c.status, 409);
    });
    await check('top-up allows only configured amounts and always funds the authenticated person', async () => {
        const r = await t.call('POST', '/api/v1/me/wallet/topups', { token,
            body: { provider: 'stripe', amount_cents: 1000, idempotency_key: 'checkout-topup-01', subject: bob.id, project_id: 'prj_bad' } });
        assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.intent.subject.id, alice.id);
        assert.strictEqual(r.json.intent.project_id, null);
    });
    await check('an uncertain provider response leaves one durable claim, never a second checkout', async () => {
        let calls = 0;
        const adapters = { stripe: { name: 'stripe', enabled: true, createCheckout: async () => { calls++; throw new Error('lost reply'); } } };
        const body = { provider: 'stripe', vibes: 100, idempotency_key: 'uncertain-checkout' };
        await assert.rejects(checkout(t.ctx, adapters, alice.id, 'vibes', body));
        await assert.rejects(checkout(t.ctx, adapters, alice.id, 'vibes', body), (e) => e.code === 'billing.checkout_pending');
        assert.strictEqual(calls, 1);
    });
    await check('freeze refuses new store charges and checkouts', async () => {
        await t.call('POST', '/api/v1/admin/freeze', { body: { on: true, reason: 'wallet test' } });
        const before = debited.size;
        await assert.rejects(pay(order('coins', 5)), (e) => e.code === 'billing.frozen');
        assert.strictEqual(debited.size, before);
        await assert.rejects(checkout(t.ctx, {}, alice.id, 'vibes', { provider: 'stripe', vibes: 100, idempotency_key: 'frozen-checkout' }), (e) => e.code === 'billing.frozen');
    });
    await t.assertReconciled();
    await t.close(); done();
})();
