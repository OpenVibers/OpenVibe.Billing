'use strict';
/**
 * The Stripe adapter against a stub Stripe API: checkout intents, purchase settlement, the
 * creator share on EVERY paid invoice (Live only moved the date on renewals), refunds and
 * disputes as reversals, cancel sent to Stripe, and adapters staying off without secrets.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ stripe: true });
    const buyer = t.user(41);
    const streamer = t.user(42);
    console.log('stripe adapter');
    const evt = (id, type, object) => ({ id, type, data: { object } });

    await check('adapters are enabled only by their secrets', async () => {
        const h = await t.call('GET', '/api/health', { token: null });
        assert.deepStrictEqual(h.json.providers, { powerchat: true, stripe: true, paypal: false, ccbill: false, nowpayments: false });
        const r = await t.call('POST', '/api/v1/intents', { body: { provider: 'paypal', kind: 'purchase', subject: buyer, bits: 1000 } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'billing.provider_disabled');
        const w = await fetch(`${t.base}/webhooks/nowpayments`, { method: 'POST', body: '{}' });
        assert.strictEqual(w.status, 404);
    });

    let buyIntent;
    await check('a purchase intent opens a Stripe checkout priced by Billing', async () => {
        const r = await t.call('POST', '/api/v1/intents', { body: { provider: 'stripe', kind: 'purchase', subject: buyer, bits: 2500, amount_cents: 1 } });
        assert.strictEqual(r.status, 201, r.text);
        buyIntent = r.json.intent;
        assert.strictEqual(buyIntent.amount_cents, 3100);
        assert.match(r.json.checkout_url, /checkout\.stripe\.test/);
        const call = t.stripe.calls.find((c) => c.url === '/checkout/sessions');
        assert.strictEqual(call.body['metadata[intent_id]'], buyIntent.id);
        assert.strictEqual(call.body['line_items[0][price_data][unit_amount]'], '3100');
        assert.strictEqual(call.auth, 'Bearer sk_test_x');
    });

    await check('checkout.session.completed settles once; a bad signature is refused', async () => {
        const e = evt('evt_1', 'checkout.session.completed', { id: 'cs_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_A', amount_total: 3100, metadata: { intent_id: buyIntent.id } });
        const bad = await t.stripeEvent(e, { secret: 'nope' });
        assert.strictEqual(bad.status, 401);
        const r = await t.stripeEvent(e);
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));
        assert.strictEqual((await t.balances(buyer.id)).credit, 2500);
        const dup = await t.stripeEvent(e);
        assert.strictEqual(dup.json.duplicate, true);
        assert.strictEqual((await t.balances(buyer.id)).credit, 2500);
    });

    let subIntent;
    await check('invoice.paid credits the streamer share on the first period AND on every renewal', async () => {
        const r = await t.call('POST', '/api/v1/intents', { body: { provider: 'stripe', kind: 'subscription', subject: buyer, streamer } });
        subIntent = r.json.intent;
        assert.strictEqual(subIntent.amount_cents, 499);
        assert.strictEqual(t.stripe.calls[t.stripe.calls.length - 1].body.mode, 'subscription');
        const link = await t.stripeEvent(evt('evt_2', 'checkout.session.completed', { id: 'cs_2', mode: 'subscription', subscription: 'sub_S1', metadata: { intent_id: subIntent.id } }));
        assert.strictEqual(link.json.result.effect, 'updated');
        const end1 = Math.floor(Date.now() / 1000) + 30 * 86400;
        const first = await t.stripeEvent(evt('evt_3', 'invoice.paid', { id: 'in_1', subscription: 'sub_S1', amount_paid: 499, lines: { data: [{ period: { end: end1 } }] } }));
        assert.strictEqual(first.json.result.effect, 'settled', JSON.stringify(first.json));
        assert.strictEqual((await t.balances(streamer.id)).payable, 349);
        const renewal = await t.stripeEvent(evt('evt_4', 'invoice.paid', { id: 'in_2', subscription: 'sub_S1', amount_paid: 499, lines: { data: [{ period: { end: end1 + 30 * 86400 } }] } }));
        assert.strictEqual(renewal.json.result.effect, 'settled');
        assert.strictEqual((await t.balances(streamer.id)).payable, 698, 'share credited again on renewal');
        const e = await t.call('GET', `/api/v1/entitlements/${buyer.id}?streamer=${streamer.id}`);
        assert.strictEqual(e.json.active, true);
        assert.strictEqual(Date.parse(e.json.expires_at), (end1 + 30 * 86400) * 1000);
        t.assertReconciled('after stripe invoices');
    });

    await check('a refunded renewal is a reversal: the period is revoked, the share stays (review)', async () => {
        const r = await t.stripeEvent(evt('evt_5', 'charge.refunded', { id: 'ch_2', invoice: 'in_2', payment_intent: 'pi_in2', amount_refunded: 499 }));
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));
        const tx = (await t.call('GET', `/api/v1/transactions/${r.json.result.txn_id}`)).json.transaction;
        assert.strictEqual(tx.type, 'refund');
        assert.strictEqual(tx.metadata.review, 'required');
        assert.strictEqual((await t.balances(streamer.id)).payable, 698);
        const e = await t.call('GET', `/api/v1/entitlements/${buyer.id}?streamer=${streamer.id}`);
        assert.strictEqual(e.json.active, true, 'the first paid period still holds');
        assert.ok(Date.parse(e.json.expires_at) < Date.now() + 31 * 86_400_000);
        t.assertReconciled('after stripe refund');
    });

    await check('a partial refund then a dispute on the purchase trace to the original', async () => {
        const p = await t.stripeEvent(evt('evt_6', 'charge.refunded', { id: 'ch_A', payment_intent: 'pi_A', amount_refunded: 1240 }));
        assert.strictEqual(p.json.result.effect, 'settled', JSON.stringify(p.json));
        let tx = (await t.call('GET', `/api/v1/transactions/${p.json.result.txn_id}`)).json.transaction;
        assert.deepStrictEqual([tx.metadata.cents, tx.metadata.bits_reversed], [1240, 1000]);
        assert.strictEqual((await t.balances(buyer.id)).credit, 1500);
        const d = await t.stripeEvent(evt('evt_7', 'charge.dispute.funds_withdrawn', { id: 'dp_1', payment_intent: 'pi_A', amount: 3100, reason: 'fraudulent' }));
        assert.strictEqual(d.json.result.effect, 'settled', JSON.stringify(d.json));
        tx = (await t.call('GET', `/api/v1/transactions/${d.json.result.txn_id}`)).json.transaction;
        assert.strictEqual(tx.type, 'chargeback');
        assert.strictEqual(tx.metadata.cents, 1860, 'only what was not refunded yet');
        assert.strictEqual((await t.balances(buyer.id)).credit, 0);
        const orig = (await t.call('GET', `/api/v1/transactions/${tx.reverses_txn}`)).json;
        assert.strictEqual(orig.reversed_by.length, 2);
        t.assertReconciled('after dispute');
    });

    await check('cancel is sent to Stripe (cancel_at_period_end) before Billing records it', async () => {
        const sub = (await t.call('GET', `/api/v1/subscriptions?subscriber=${buyer.id}`)).json.subscriptions[0];
        assert.strictEqual(sub.provider, 'stripe');
        t.stripe.state.fail = true;
        const failed = await t.call('POST', `/api/v1/subscriptions/${sub.id}/cancel`, { body: {} });
        assert.strictEqual(failed.status, 502);
        assert.strictEqual((await t.call('GET', `/api/v1/subscriptions/${sub.id}`)).json.subscription.cancel_at_period_end, false);
        t.stripe.state.fail = false;
        const ok = await t.call('POST', `/api/v1/subscriptions/${sub.id}/cancel`, { body: {} });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json.provider_sync, 'stripe_cancel_at_period_end');
        assert.strictEqual(ok.json.subscription.cancel_at_period_end, true);
        const call = t.stripe.calls[t.stripe.calls.length - 1];
        assert.deepStrictEqual([call.method, call.url, call.body.cancel_at_period_end], ['POST', '/subscriptions/sub_S1', 'true']);
        const del = await t.stripeEvent(evt('evt_8', 'customer.subscription.deleted', { id: 'sub_S1' }));
        assert.strictEqual(del.json.result.effect, 'updated');
        assert.strictEqual((await t.call('GET', `/api/v1/subscriptions/${sub.id}`)).json.subscription.status, 'canceled');
    });

    await t.close();
    done();
})();
