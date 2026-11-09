'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { startProviderStub } = require('./helpers/stubs');

(async () => {
    for (const kind of ['vibes', 'topup']) {
        const stub = await startProviderStub();
        const t = await boot({ env: { BILLING_AUTHORITY: 'billing', PAYPAL_CLIENT_ID: 'pp', PAYPAL_CLIENT_SECRET: 'pps',
            PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_API_BASE: stub.url, BILLING_CREDITS: '1', BILLING_CREDITS_TOPUP: '1',
            BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000', BILLING_CREDITS_TOPUP_FEE_BPS: '0' } });
        try {
            await check(`${kind}: PayPal return captures the saved intent once and honors the owner switch`, async () => {
                const buyer = t.user(410), token = t.network.signUser({ subject_id: buyer.id });
                const start = await t.call('POST', kind === 'vibes' ? '/api/v1/me/vibes/buy' : '/api/v1/me/wallet/topups', {
                    token, body: { provider: 'paypal', idempotency_key: 'paypal-return-01', ...(kind === 'vibes' ? { vibes: 1000 } : { amount_cents: 1000 }) },
                });
                assert.strictEqual(start.status, 200, start.text);
                const go = (token) => fetch(`${t.base}/checkout/success?token=${token}`, { redirect: 'manual' });
                assert.strictEqual((await go('unknown-order')).status, 404);
                t.network.state.moneyFrozen = true;
                assert.strictEqual((await go('PPORDER1')).status, 503);
                assert.strictEqual(stub.calls.filter((c) => c.url.endsWith('/capture')).length, 0);
                t.network.state.moneyFrozen = false;
                const result = await go('PPORDER1');
                assert.strictEqual(result.status, 303);
                assert.strictEqual(result.headers.get('location'), 'https://openvibe.network/wallet');
                assert.strictEqual((await go('PPORDER1')).status, 303);
                assert.strictEqual(stub.calls.filter((c) => c.url.endsWith('/capture')).length, 1);
                const intent = await t.db.prepare('SELECT status, settled_txn FROM payment_intents WHERE id = ?').get(start.json.intent.id);
                assert.strictEqual(intent.status, 'settled'); assert(intent.settled_txn);
                if (kind === 'vibes') assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
                await t.assertReconciled('wallet PayPal return');
            });
        } finally { await t.close(); await stub.close(); }
    }
    done();
})();
