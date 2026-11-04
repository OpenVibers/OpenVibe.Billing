'use strict';
/**
 * Credits top-up (D9): a person pays USD through Billing's multi-purpose provider pipeline (PowerChat, Stripe,
 * PayPal, CCBill, NOWPayments) and the one shared credits_topup plan credits their (subject, project_id) usd_credit
 * account at nano-USD precision. The fee the owner set goes to platform_revenue, replay credits once, and a refund
 * after partial spend leaves the balance at 0 with the spent part recorded as a debt. Everything is behind
 * BILLING_CREDITS_TOPUP; the terms come only from topupTerms(ctx), and nothing is configured by default.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { startProviderStub } = require('./helpers/stubs');

const INF = ['billing.credit.hold.create', 'billing.credit.hold.extend', 'billing.credit.hold.settle', 'billing.credit.hold.release'];
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const ZERO_RETAIL = { version: 'rc-topup', nano_usd_per_m: { input: '0', cached_read: '0', cache_write: '0', output: '0' }, per_request_nano_usd: '4000000000' };
const evt = (id, type, object) => ({ id, type, data: { object } });

async function assertJournalBalances(db, label) {
    const rows = await db.prepare(`SELECT a.currency, SUM(e.amount)::text AS total FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id GROUP BY a.currency`).all();
    for (const r of rows) assert.strictEqual(String(r.total), '0', `journal not balanced for ${r.currency} ${label}: ${r.total}`);
}

const nanoBalance = async (t, kind) => (await t.db.prepare(`SELECT COALESCE(SUM(b.balance), 0)::text AS n FROM accounts a
    JOIN account_balances b ON b.account_id = a.id WHERE a.kind = ? AND a.currency = 'nano-usd'`).get(kind)).n;

(async () => {
    console.log('credits top-up');
    const pp = await startProviderStub();
    const t = await boot({
        stripe: true,
        env: {
            BILLING_CREDITS: '1', BILLING_CREDITS_TOPUP: '1',
            BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000,2500', BILLING_CREDITS_TOPUP_FEE_BPS: '250',
            PAYPAL_CLIENT_ID: 'pp', PAYPAL_CLIENT_SECRET: 'pps', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_API_BASE: pp.url,
        },
    });
    const alice = t.user(201);
    const aliceToken = t.network.signUser({ subject_id: alice.id, username: 'alice' });
    const start = (body, token = aliceToken) => t.call('POST', '/api/me/credits/topups', { body, token });
    const read = async (token = aliceToken) => (await fetch(`${t.base}/api/me/credits?project_id=${PRJ}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const pcDonation = (eventId, cents, ref) => ({ type: 'donation.completed', streamer: { id: 'pc1', username: 'openvibe' }, data: { eventId, amountUsdCents: cents, appExternalRef: ref } });
    const paypalHook = async (event) => {
        const r = await fetch(`${t.base}/webhooks/paypal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'paypal-transmission-sig': 'good', 'paypal-transmission-id': 'x', 'paypal-auth-algo': 'SHA256withRSA' },
            body: JSON.stringify(event),
        });
        return { status: r.status, json: await r.json() };
    };

    await check('topupTerms is the one reader of the terms: env today, no defaults, invalid refuses', async () => {
        const { topupTerms } = require('../server/ops/credits');
        assert.deepStrictEqual(topupTerms(t.ctx), { enabled: true, amountsCents: [1000, 2500], feeBps: 250, configured: true, problem: null });
        const off = topupTerms({ env: {} });
        assert.deepStrictEqual([off.enabled, off.configured, off.amountsCents, off.feeBps], [false, false, [], null]);
        const bad = topupTerms({ env: { BILLING_CREDITS_TOPUP: '1', BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000,abc', BILLING_CREDITS_TOPUP_FEE_BPS: '250' } });
        assert.strictEqual(bad.configured, false);
        assert.match(bad.problem, /invalid amount/);
        const zero = topupTerms({ env: { BILLING_CREDITS_TOPUP: '1', BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000', BILLING_CREDITS_TOPUP_FEE_BPS: '0' } });
        assert.deepStrictEqual([zero.configured, zero.feeBps], [true, 0], '0 bps is a configured fee');
    });

    let topupIntent;
    await check('Stripe: a person starts an allowed top-up; the existing checkout charges the amount plus the fee', async () => {
        const r = await start({ provider: 'stripe', project_id: PRJ, amount_cents: 1000 });
        assert.strictEqual(r.status, 201, r.text);
        topupIntent = r.json.intent;
        assert.strictEqual(topupIntent.kind, 'credits_topup');
        assert.strictEqual(topupIntent.project_id, PRJ);
        assert.strictEqual(topupIntent.amount_cents, 1025, 'the provider charges the top-up plus the 2.5% fee');
        assert.strictEqual(topupIntent.fee_cents, 25);
        assert.strictEqual(topupIntent.topup.amount_nano_usd, '10000000000');
        assert.match(r.json.checkout_url, /checkout\.stripe\.test/);
        const call = t.stripe.calls[t.stripe.calls.length - 1];
        assert.strictEqual(call.url, '/checkout/sessions');
        assert.strictEqual(call.body['metadata[intent_id]'], topupIntent.id);
        assert.strictEqual(call.body['line_items[0][price_data][unit_amount]'], '1025');
        assert.strictEqual(call.body.mode, 'payment');
    });

    await check('an amount the owner did not list is 422 and opens no checkout', async () => {
        const before = t.stripe.calls.length;
        const r = await start({ provider: 'stripe', project_id: PRJ, amount_cents: 999 });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json.code, 'billing.amount_not_allowed');
        assert.strictEqual(t.stripe.calls.length, before);
        const n = await t.db.prepare("SELECT COUNT(*)::int AS n FROM payment_intents WHERE kind = 'credits_topup'").get();
        assert.strictEqual(n.n, 1);
    });

    await check('Stripe: the paid webhook credits exactly the amount in nano-USD and books the fee to platform_revenue', async () => {
        const r = await t.stripeEvent(evt('evt_topup_1', 'checkout.session.completed', {
            id: 'cs_topup_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_topup_1', amount_total: 1025,
            metadata: { intent_id: topupIntent.id },
        }));
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));
        const s = await read();
        assert.strictEqual(s.balance_nano_usd, '10000000000');
        assert.strictEqual(s.topups.length, 1);
        assert.strictEqual(s.topups[0].status, 'settled');
        assert.strictEqual(s.topups[0].amount_nano_usd, '10000000000');
        assert.strictEqual(s.topups[0].fee_nano_usd, '250000000');
        assert.strictEqual(await nanoBalance(t, 'platform_revenue'), '250000000', 'the fee is revenue');
        assert.strictEqual(await nanoBalance(t, 'provider_clearing'), '-10250000000', 'the provider is holding the paid cents');
        await assertJournalBalances(t.db, 'after the paid top-up');
    });

    await check('Stripe: a redelivery, and a second provider event for the same payment, credit exactly once', async () => {
        const paid = evt('evt_topup_1', 'checkout.session.completed', {
            id: 'cs_topup_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_topup_1', amount_total: 1025,
            metadata: { intent_id: topupIntent.id },
        });
        const dup = await t.stripeEvent(paid);
        assert.strictEqual(dup.json.duplicate, true);
        const other = await t.stripeEvent(evt('evt_topup_1b', 'checkout.session.completed', {
            id: 'cs_topup_1', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_topup_1', amount_total: 1025,
            metadata: { intent_id: topupIntent.id },
        }));
        assert.strictEqual(other.status, 200, JSON.stringify(other.json));
        assert.strictEqual(other.json.result.effect, 'duplicate_receipt', JSON.stringify(other.json));
        const n = await t.db.prepare("SELECT COUNT(*)::int AS n FROM transactions WHERE json_extract(metadata, '$.credit') = 'topup'").get();
        assert.strictEqual(n.n, 1);
        assert.strictEqual((await read()).balance_nano_usd, '10000000000');
    });

    await check('Stripe: a refund after partial spend debits what remains, leaves the balance at 0 and records the debt', async () => {
        // Spend 4.00 USD of the 10.00 USD through the inference subledger.
        const hold = await t.call('POST', '/internal/credits/holds', {
            cap: INF, sub: 'svc:ai',
            body: { idempotency_key: 'topup-spend-hold', subject: { type: 'user', id: alice.id }, project_id: PRJ, max_nano_usd: '4000000000', rate_version: 'rc-topup', request_fingerprint: 'topup-spend-fp' },
        });
        assert.strictEqual(hold.status, 201, hold.text);
        const settled = await t.call('POST', `/internal/credits/holds/${hold.json.hold_id}/settle`, {
            cap: INF, sub: 'svc:ai',
            body: {
                idempotency_key: 'topup-spend-settle', usage: { input_tokens: 0, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
                retail: ZERO_RETAIL, supply_cost_nano_usd: '0', byok: false, attempts: [],
            },
        });
        assert.strictEqual(settled.status, 201, settled.text);
        assert.strictEqual(settled.json.charge_nano_usd, '4000000000');
        assert.strictEqual((await read()).balance_nano_usd, '6000000000');

        const r = await t.stripeEvent(evt('evt_topup_refund', 'charge.refunded', { id: 'ch_topup_1', payment_intent: 'pi_topup_1', amount_refunded: 1025 }));
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));

        const s = await read();
        assert.strictEqual(s.balance_nano_usd, '0', 'the account never goes below zero');
        assert.strictEqual(s.available_nano_usd, '0');
        assert.strictEqual(s.topups[0].refunded_nano_usd, '6000000000');
        assert.strictEqual(s.topups[0].debt_nano_usd, '4000000000', 'the spent part is a debt');
        assert.strictEqual(s.topups[0].status, 'refunded_with_debt');
        const debts = await t.db.prepare('SELECT * FROM credit_topup_debts').all();
        assert.strictEqual(debts.length, 1);
        assert.strictEqual(String(debts[0].amount_nano_usd), '4000000000');
        assert.strictEqual(await nanoBalance(t, 'platform_revenue'), '4000000000', 'the fee is returned; the collected charge stays revenue');
        assert.strictEqual(await nanoBalance(t, 'credit_topup_debt'), '-4000000000');
        await assertJournalBalances(t.db, 'after the top-up refund');

        const rec = await t.assertReconciled('after the top-up refund');
        assert.strictEqual(rec.warnings.credit_debts.length, 1, 'reconciliation reports the debt');
        assert.strictEqual(rec.totals.credit_topup_debt_nano_usd, '4000000000');
    });

    await check('PowerChat: a site-account tip carrying pccredit:<intent> settles through the shared plan, once', async () => {
        const bob = t.user(202);
        const bobToken = t.network.signUser({ subject_id: bob.id, username: 'bob' });
        const r = await start({ provider: 'powerchat', project_id: PRJ, amount_cents: 1000 }, bobToken);
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.checkout_url, null, 'PowerChat has no hosted checkout URL');
        assert.strictEqual(r.json.intent.checkout_ref, `pccredit:${r.json.intent.id}`);
        const donation = pcDonation('don-cred-pc', 1025, r.json.intent.checkout_ref);
        const first = await t.powerchat(donation, { deliveryId: 'dlv-cred-pc' });
        assert.strictEqual(first.status, 200, JSON.stringify(first));
        assert.strictEqual(first.json.result.effect, 'settled', JSON.stringify(first));
        assert.strictEqual((await read(bobToken)).balance_nano_usd, '10000000000');
        const dup = await t.powerchat(donation, { deliveryId: 'dlv-cred-pc' });
        assert.strictEqual(dup.json.duplicate, true);
        const other = await t.powerchat(donation, { deliveryId: 'dlv-cred-pc-retry' });
        assert.strictEqual(other.json.result.effect, 'duplicate_receipt', JSON.stringify(other));

        const refund = await t.powerchat({
            type: 'donation.refunded', streamer: { id: 'pc1', username: 'openvibe' },
            data: { eventId: 'rf-cred-pc', originalEventId: 'don-cred-pc', refundedUsdCents: 1025 },
        });
        assert.strictEqual(refund.status, 200, JSON.stringify(refund));
        assert.strictEqual(refund.json.result.effect, 'settled', JSON.stringify(refund));
        const s = await read(bobToken);
        assert.strictEqual(s.balance_nano_usd, '0', 'a full refund of unspent credit leaves nothing');
        assert.strictEqual(s.topups[0].status, 'refunded');
        assert.strictEqual(s.topups[0].debt_nano_usd, '0');
    });

    await check('PayPal: the capture completes the shared plan; a replay and a second event for it credit once', async () => {
        const carol = t.user(203);
        const carolToken = t.network.signUser({ subject_id: carol.id, username: 'carol' });
        const r = await start({ provider: 'paypal', project_id: PRJ, amount_cents: 1000 }, carolToken);
        assert.strictEqual(r.status, 201, r.text);
        assert.match(r.json.checkout_url, /paypal\.test/);
        const order = pp.calls.find((c) => c.url === '/v2/checkout/orders');
        const orderBody = JSON.parse(order.raw);
        assert.strictEqual(orderBody.purchase_units[0].custom_id, r.json.intent.id);
        assert.strictEqual(orderBody.purchase_units[0].amount.value, '10.25');

        const event = {
            id: 'WH-TOPUP-1', event_type: 'PAYMENT.CAPTURE.COMPLETED',
            resource: { id: 'CAP-TOPUP', custom_id: r.json.intent.id, amount: { currency_code: 'USD', value: '10.25' } },
        };
        const paid = await paypalHook(event);
        assert.strictEqual(paid.status, 200, JSON.stringify(paid));
        assert.strictEqual(paid.json.result.effect, 'settled', JSON.stringify(paid));
        assert.strictEqual((await read(carolToken)).balance_nano_usd, '10000000000');
        const dup = await paypalHook(event);
        assert.strictEqual(dup.json.duplicate, true);
        const other = await paypalHook({ ...event, id: 'WH-TOPUP-1b' });
        assert.strictEqual(other.json.result.effect, 'duplicate_receipt', JSON.stringify(other));

        const refund = await paypalHook({
            id: 'WH-TOPUP-RF', event_type: 'PAYMENT.CAPTURE.REFUNDED',
            resource: { id: 'RF-TOPUP', amount: { currency_code: 'USD', value: '10.25' }, links: [{ rel: 'up', href: 'https://api.paypal.test/v2/payments/captures/CAP-TOPUP' }] },
        });
        assert.strictEqual(refund.status, 200, JSON.stringify(refund));
        assert.strictEqual(refund.json.result.effect, 'settled', JSON.stringify(refund));
        const s = await read(carolToken);
        assert.strictEqual(s.balance_nano_usd, '0');
        assert.strictEqual(s.topups[0].status, 'refunded');
        await assertJournalBalances(t.db, 'after every provider top-up');
        await t.assertReconciled('after powerchat and paypal top-ups');
    });

    await check('a paid event while the top-up switch is off is recorded for review and moves no money', async () => {
        const dave = t.user(204);
        const daveToken = t.network.signUser({ subject_id: dave.id, username: 'dave' });
        const r = await start({ provider: 'stripe', project_id: PRJ, amount_cents: 1000 }, daveToken);
        assert.strictEqual(r.status, 201, r.text);
        const saved = t.ctx.env.BILLING_CREDITS_TOPUP;
        t.ctx.env.BILLING_CREDITS_TOPUP = '0';
        try {
            const paid = await t.stripeEvent(evt('evt_topup_off', 'checkout.session.completed', {
                id: 'cs_topup_off', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_topup_off', amount_total: 1025,
                metadata: { intent_id: r.json.intent.id },
            }));
            assert.strictEqual(paid.status, 200, JSON.stringify(paid));
            assert.strictEqual(paid.json.result.effect, 'none', JSON.stringify(paid.json));
            assert.strictEqual(paid.json.result.review, true);
            assert.strictEqual((await read(daveToken)).topups.length, 0, 'no credit and no charge');
            const txns = await t.db.prepare("SELECT COUNT(*)::int AS n FROM transactions WHERE json_extract(metadata, '$.intent_id') = ?").get(r.json.intent.id);
            assert.strictEqual(txns.n, 0);
        } finally {
            t.ctx.env.BILLING_CREDITS_TOPUP = saved;
        }
        await t.assertReconciled('after a refused paid top-up');
    });

    await check('the economy freeze refuses a top-up before any intent or checkout', async () => {
        await require('../server/ops/admin').setFreeze(t.ctx, { on: true, reason: 'top-up test' });
        const before = t.stripe.calls.length;
        const intentsBefore = (await t.db.prepare("SELECT COUNT(*)::int AS n FROM payment_intents WHERE kind = 'credits_topup'").get()).n;
        const r = await start({ provider: 'stripe', project_id: PRJ, amount_cents: 1000 });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json.code, 'billing.frozen');
        assert.strictEqual(t.stripe.calls.length, before);
        const intentsAfter = (await t.db.prepare("SELECT COUNT(*)::int AS n FROM payment_intents WHERE kind = 'credits_topup'").get()).n;
        assert.strictEqual(intentsAfter, intentsBefore, 'no intent while frozen');
        await require('../server/ops/admin').setFreeze(t.ctx, { on: false });
    });

    await t.close();
    await pp.close();

    await check('unset amounts or fee refuses with 503 billing.topup_unconfigured', async () => {
        const none = await boot({ env: { BILLING_CREDITS: '1', BILLING_CREDITS_TOPUP: '1' } });
        const u = none.user(202);
        const r = await none.call('POST', '/api/me/credits/topups', {
            token: none.network.signUser({ subject_id: u.id, username: 'u' }),
            body: { provider: 'stripe', project_id: PRJ, amount_cents: 1000 },
        });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual(r.json.code, 'billing.topup_unconfigured');
        await none.close();

        const bad = await boot({ env: { BILLING_CREDITS: '1', BILLING_CREDITS_TOPUP: '1', BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000', BILLING_CREDITS_TOPUP_FEE_BPS: 'abc' } });
        const v = bad.user(203);
        const n = await bad.call('POST', '/api/me/credits/topups', {
            token: bad.network.signUser({ subject_id: v.id, username: 'v' }),
            body: { provider: 'stripe', project_id: PRJ, amount_cents: 1000 },
        });
        assert.strictEqual(n.status, 503, n.text);
        assert.strictEqual(n.json.code, 'billing.topup_unconfigured');
        await bad.close();
    });

    await check('with BILLING_CREDITS_TOPUP off nothing opens: 404, no intent, no checkout; the statement still reads', async () => {
        const off = await boot({ stripe: true, env: { BILLING_CREDITS: '1' } });
        const w = off.user(204);
        const token = off.network.signUser({ subject_id: w.id, username: 'w' });
        const r = await off.call('POST', '/api/me/credits/topups', { token, body: { provider: 'stripe', project_id: PRJ, amount_cents: 1000 } });
        assert.strictEqual(r.status, 404, r.text);
        assert.strictEqual(r.json.code, 'billing.topup_disabled');
        assert.strictEqual(off.stripe.calls.length, 0);
        const n = await off.db.prepare("SELECT COUNT(*)::int AS n FROM payment_intents WHERE kind = 'credits_topup'").get();
        assert.strictEqual(n.n, 0);
        const s = await (await fetch(`${off.base}/api/me/credits?project_id=${PRJ}`, { headers: { Authorization: `Bearer ${token}` } })).json();
        assert.deepStrictEqual(s.topups, []);
        await off.close();
    });

    await check('a fee of 0 is allowed (it is set, not defaulted)', async () => {
        const free = await boot({ stripe: true, env: { BILLING_CREDITS: '1', BILLING_CREDITS_TOPUP: '1', BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000', BILLING_CREDITS_TOPUP_FEE_BPS: '0' } });
        const x = free.user(205);
        const r = await free.call('POST', '/api/me/credits/topups', {
            token: free.network.signUser({ subject_id: x.id, username: 'x' }),
            body: { provider: 'stripe', project_id: PRJ, amount_cents: 1000 },
        });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.intent.amount_cents, 1000);
        assert.strictEqual(r.json.intent.fee_cents, 0);
        await free.close();
    });

    done();
})();
