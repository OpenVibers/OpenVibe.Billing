'use strict';
/**
 * The ported PayPal, CCBill and NOWPayments adapters (all OFF in production), enabled here against
 * a stub provider API: verification, settlement exactly once, and refunds/chargebacks as reversals.
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const { sortObject } = require('../server/providers/nowpayments');

async function startProviderStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            calls.push({ method: req.method, url: req.url, raw });
            const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (req.url === '/v1/oauth2/token') return json(200, { access_token: 'pp-token' });
            if (req.url === '/v1/notifications/verify-webhook-signature') {
                const body = JSON.parse(raw);
                return json(200, { verification_status: body.transmission_sig === 'good' ? 'SUCCESS' : 'FAILURE' });
            }
            if (req.url === '/v2/checkout/orders') return json(201, { id: 'PPORDER1', links: [{ rel: 'approve', href: 'https://paypal.test/approve/PPORDER1' }] });
            const cap = req.url.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
            if (cap) {
                const custom = calls.find((c) => c.url === '/v2/checkout/orders');
                const intentId = JSON.parse(custom.raw).purchase_units[0].custom_id;
                return json(201, { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-9', custom_id: intentId, amount: { currency_code: 'USD', value: '13.00' } }] } }] });
            }
            if (req.url === '/invoice') return json(200, { id: 777, invoice_url: 'https://nowpayments.test/invoice/777' });
            json(404, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

(async () => {
    const stub = await startProviderStub();
    const t = await boot({
        env: {
            PAYPAL_CLIENT_ID: 'pp', PAYPAL_CLIENT_SECRET: 'pps', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_API_BASE: stub.url,
            CCBILL_WEBHOOK_SECRET: 'cc-secret', CCBILL_FLEXFORM_ID: 'ff1', CCBILL_CLIENT_ACCOUNT: '900000', CCBILL_SUBACCOUNT: '0000', CCBILL_SALT: 'salt',
            NOWPAYMENTS_IPN_SECRET: 'np-secret', NOWPAYMENTS_API_KEY: 'np-key', NOWPAYMENTS_API_BASE: stub.url,
        },
    });
    const buyer = t.user(61);
    console.log('providers (PayPal, CCBill, NOWPayments)');
    const intent = async (provider, bits = 1000) => {
        const r = await t.call('POST', '/api/v1/intents', { body: { provider, kind: 'purchase', subject: buyer, bits } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json;
    };

    await check('CCBill: shared secret, sale settles once with the reported price, chargeback reverses it', async () => {
        const { intent: i, checkout_url: url } = await intent('ccbill');
        assert.ok(url.includes(`X-intent=${i.id}`) && url.includes('initialPrice=13.00'));
        const post = (qs, body) => fetch(`${t.base}/webhooks/ccbill?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
        assert.strictEqual((await post('secret=nope&eventType=NewSaleSuccess', { transactionId: 'T1', 'X-intent': i.id, billedInitialPrice: '13.00' })).status, 401);
        const noPrice = await post('secret=cc-secret&eventType=NewSaleSuccess', { transactionId: 'T0', 'X-intent': i.id });
        assert.strictEqual(noPrice.json.result.review, true);
        const ok = await post('secret=cc-secret&eventType=NewSaleSuccess', { transactionId: 'T1', 'X-intent': i.id, billedInitialPrice: '13.00' });
        assert.strictEqual(ok.json.result.effect, 'settled', JSON.stringify(ok.json));
        assert.strictEqual(t.db.prepare("SELECT payload FROM provider_events WHERE provider = 'ccbill' AND provider_event_id = 'NewSaleSuccess:T1'").get().payload.includes('cc-secret'), false, 'the secret is never stored');
        const again = await post('secret=cc-secret&eventType=NewSaleSuccess', { transactionId: 'T1', 'X-intent': i.id, billedInitialPrice: '13.00' });
        assert.strictEqual(again.json.duplicate, true);
        assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
        const cb = await post('secret=cc-secret&eventType=Chargeback', { transactionId: 'T1', amount: '13.00' });
        assert.strictEqual(cb.json.result.effect, 'settled', JSON.stringify(cb.json));
        assert.strictEqual((await t.balances(buyer.id)).credit, 0);
        t.assertReconciled('after ccbill');
    });

    await check('NOWPayments: HMAC-SHA512 IPN, several statuses settle one payment once, refunded reverses', async () => {
        const { intent: i, checkout_url: url } = await intent('nowpayments');
        assert.strictEqual(url, 'https://nowpayments.test/invoice/777');
        const ipn = (body, secret = 'np-secret') => {
            const sig = crypto.createHmac('sha512', secret).update(JSON.stringify(sortObject(body))).digest('hex');
            return fetch(`${t.base}/webhooks/nowpayments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-nowpayments-sig': sig }, body: JSON.stringify(body) })
                .then(async (r) => ({ status: r.status, json: await r.json() }));
        };
        const body = { payment_id: 55, order_id: i.id, price_amount: 13, price_currency: 'usd' };
        assert.strictEqual((await ipn({ ...body, payment_status: 'finished' }, 'wrong')).status, 401);
        const a = await ipn({ ...body, payment_status: 'confirmed' });
        assert.strictEqual(a.json.result.effect, 'settled', JSON.stringify(a.json));
        const b = await ipn({ ...body, payment_status: 'finished' });
        assert.strictEqual(b.json.result.effect, 'duplicate_receipt');
        assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
        const r = await ipn({ ...body, payment_status: 'refunded' });
        assert.strictEqual(r.json.result.effect, 'settled');
        assert.strictEqual((await t.balances(buyer.id)).credit, 0);
        t.assertReconciled('after nowpayments');
    });

    await check('PayPal: verified webhooks, capture after return settles once, reversal is a chargeback', async () => {
        const { intent: i, checkout_url: url } = await intent('paypal');
        assert.strictEqual(url, 'https://paypal.test/approve/PPORDER1');
        const cap = await t.call('POST', `/api/v1/intents/${i.id}/capture`, { body: {} });
        assert.strictEqual(cap.status, 200, cap.text);
        assert.strictEqual(cap.json.result.effect, 'settled');
        assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
        const hook = (event, sig = 'good') => fetch(`${t.base}/webhooks/paypal`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'paypal-transmission-sig': sig, 'paypal-transmission-id': 'x', 'paypal-auth-algo': 'SHA256withRSA' }, body: JSON.stringify(event),
        }).then(async (r) => ({ status: r.status, json: await r.json() }));
        const completed = { id: 'WH-EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-9', custom_id: i.id, amount: { currency_code: 'USD', value: '13.00' } } };
        assert.strictEqual((await hook(completed, 'bad')).status, 401);
        const dup = await hook(completed);
        assert.strictEqual(dup.json.result.effect, 'duplicate_receipt');
        assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
        const rev = await hook({ id: 'WH-EVT-2', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: 'RF-1', amount: { currency_code: 'USD', value: '13.00' }, links: [{ rel: 'up', href: 'https://api.paypal.test/v2/payments/captures/CAP-9' }] } });
        assert.strictEqual(rev.json.result.effect, 'settled', JSON.stringify(rev.json));
        const tx = (await t.call('GET', `/api/v1/transactions/${rev.json.result.txn_id}`)).json.transaction;
        assert.strictEqual(tx.type, 'chargeback');
        assert.strictEqual((await t.balances(buyer.id)).credit, 0);
        t.assertReconciled('after paypal');
    });

    await t.close();
    await stub.close();
    done();
})();
