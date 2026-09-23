'use strict';
/**
 * PowerChat receipts: verification, exactly-once effects, every checkout route, EXTERNAL tips,
 * refunds/chargebacks tracing to their original, and the freeze switch queueing deliveries.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const buyer = t.user(21);
    const streamer = t.user(22);
    const pcdonStreamerLiveId = 23;
    const pcdonStreamer = t.network.addUser(pcdonStreamerLiveId);
    console.log('webhooks (PowerChat)');

    const intent = async (body) => {
        const r = await t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', ...body } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.intent;
    };
    const donation = (data, streamerName = 'openvibe') => ({ type: 'donation.completed', streamer: { id: 'pc1', username: streamerName }, data: { eventId: `don-${Math.random().toString(36).slice(2)}`, ...data } });
    const eventCount = () => t.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get().n;

    await check('an unsigned or stale delivery is refused and not stored', async () => {
        const bad = await t.powerchat(donation({ amountUsdCents: 100 }), { secret: 'wrong' });
        assert.strictEqual(bad.status, 401);
        const stale = await t.powerchat(donation({ amountUsdCents: 100 }), { ts: Date.now() - 16 * 60 * 1000 });
        assert.strictEqual(stale.status, 401);
        assert.strictEqual(eventCount(), 0);
    });

    let buyIntent;
    await check('pcorder: a confirmed tip settles the purchase intent into credit', async () => {
        buyIntent = await intent({ kind: 'purchase', subject: buyer, bits: 1000 });
        assert.strictEqual(buyIntent.amount_cents, 1300);
        assert.strictEqual(buyIntent.checkout_ref, `pcorder:${buyIntent.id}`);
        const r = await t.powerchat(donation({ eventId: 'don-A', amountUsdCents: 1300, appExternalRef: buyIntent.checkout_ref }), { deliveryId: 'dlv-A' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.result.effect, 'settled');
        assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
        const i = await t.call('GET', `/api/v1/intents/${buyIntent.id}`);
        assert.strictEqual(i.json.intent.status, 'settled');
        t.assertReconciled('after pcorder');
    });

    await check('a duplicated delivery produces exactly one accounting effect', async () => {
        const again = await t.powerchat(donation({ eventId: 'don-A', amountUsdCents: 1300, appExternalRef: buyIntent.checkout_ref }), { deliveryId: 'dlv-A' });
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.json.duplicate, true);
        const redelivered = await t.powerchat(donation({ eventId: 'don-A', amountUsdCents: 1300, appExternalRef: buyIntent.checkout_ref }), { deliveryId: 'dlv-A-retry' });
        assert.strictEqual(redelivered.json.result.effect, 'duplicate_receipt');
        assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE receipt_ref = 'powerchat:don-A'").get().n, 1);
        t.assertReconciled('after duplicates');
    });

    await check('test deliveries and app echoes move no money', async () => {
        const test = await t.powerchat(donation({ amountUsdCents: 500, isTest: true, appExternalRef: 'pcorder:whatever' }));
        assert.strictEqual(test.json.result.effect, 'none');
        const manual = await t.powerchat(donation({ amountUsdCents: 500, source: 'manual_test', appExternalRef: 'pcorder:whatever' }));
        assert.strictEqual(manual.json.result.effect, 'none');
        const echo = await t.powerchat(donation({ amountUsdCents: 500, source: 'developer_app' }));
        assert.match(echo.json.result.reason, /echo/);
    });

    await check('pcsub via the site account: the streamer share is credited, the fee is platform revenue', async () => {
        const i = await intent({ kind: 'subscription', subject: buyer, streamer, route: 'site' });
        assert.deepStrictEqual([i.amount_cents, i.fee_cents, i.route], [549, 50, 'site']);
        const r = await t.powerchat(donation({ amountUsdCents: 549, appExternalRef: i.checkout_ref }));
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));
        assert.strictEqual((await t.balances(streamer.id)).payable, 349);
        const e = await t.call('GET', `/api/v1/entitlements/${buyer.id}?streamer=${streamer.id}`, { cap: ['billing.entitlement.check'] });
        assert.strictEqual(e.json.active, true);
        const tx = t.db.prepare('SELECT metadata FROM transactions WHERE id = ?').get(r.json.result.txn_id);
        const m = JSON.parse(tx.metadata);
        assert.deepStrictEqual([m.paid_cents, m.fee_cents, m.share_bits], [549, 50, 349]);
        t.assertReconciled('after site sub');
    });

    await check('pcsub direct is EXTERNAL: the entitlement is granted, no money is booked', async () => {
        const other = t.user(24);
        const i = await intent({ kind: 'subscription', subject: other, streamer, route: 'direct', receiving_account: 'StreamerPC' });
        assert.strictEqual(i.amount_cents, 499);
        const before = (await t.balances(streamer.id)).payable;
        const r = await t.powerchat(donation({ amountUsdCents: 499, appExternalRef: i.checkout_ref }, 'streamerpc'));
        assert.strictEqual(r.json.result.effect, 'settled');
        const txn = await t.call('GET', `/api/v1/transactions/${r.json.result.txn_id}`);
        assert.deepStrictEqual(txn.json.transaction.entries, []);
        assert.strictEqual(txn.json.transaction.metadata.external, true);
        assert.strictEqual((await t.balances(streamer.id)).payable, before);
        const e = await t.call('GET', `/api/v1/entitlements/${other.id}?streamer=${streamer.id}`);
        assert.strictEqual(e.json.active, true);
    });

    await check('an underpaid site subscription becomes a plain site-routed tip', async () => {
        const i = await intent({ kind: 'subscription', subject: t.user(25), streamer, route: 'site' });
        const before = (await t.balances(streamer.id)).payable;
        const r = await t.powerchat(donation({ amountUsdCents: 300, appExternalRef: i.checkout_ref }));
        assert.strictEqual(r.json.result.effect, 'settled');
        assert.strictEqual((await t.balances(streamer.id)).payable, before + 300);
    });

    await check('pcdon (legacy Live ids) resolves the streamer and credits their payable (MONEY)', async () => {
        const r = await t.powerchat(donation({ amountUsdCents: 250, appExternalRef: `pcdon:${pcdonStreamerLiveId}:21` }));
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));
        assert.strictEqual((await t.balances(pcdonStreamer)).payable, 250);
        assert.ok(t.network.resolveCalls.some((c) => c.system === 'live' && c.ids.includes(String(pcdonStreamerLiveId))));
        const unknown = await t.powerchat(donation({ amountUsdCents: 250, appExternalRef: 'pcdon:999:0' }));
        assert.strictEqual(unknown.json.result.effect, 'none');
        assert.strictEqual(unknown.json.result.review, true);
    });

    await check("a tip on a streamer's own PowerChat is EXTERNAL; an unattributed site tip is flagged", async () => {
        const ext = await t.powerchat(donation({ amountUsdCents: 1000, appExternalRef: 'goal:12' }, 'somestreamer'));
        assert.match(ext.json.result.reason, /EXTERNAL/);
        const site = await t.powerchat(donation({ amountUsdCents: 1000 }, 'openvibe'));
        assert.strictEqual(site.json.result.review, true);
        const rec = t.assertReconciled('after none-effects');
        assert.ok(rec.warnings.events_for_review.length >= 2);
    });

    await check('a refund traces to the original purchase and claws the credit back', async () => {
        const i = await intent({ kind: 'purchase', subject: buyer, bits: 500 });
        const pay = await t.powerchat(donation({ eventId: 'don-R', amountUsdCents: 700, appExternalRef: i.checkout_ref }));
        assert.strictEqual(pay.json.result.effect, 'settled');
        assert.strictEqual((await t.balances(buyer.id)).credit, 1500);
        const ref = await t.powerchat({ type: 'donation.refunded', streamer: { username: 'openvibe' }, data: { eventId: 'rf-1', originalEventId: 'don-R', refundedUsdCents: 700 } });
        assert.strictEqual(ref.json.result.effect, 'settled', JSON.stringify(ref.json));
        const tx = await t.call('GET', `/api/v1/transactions/${ref.json.result.txn_id}`);
        assert.strictEqual(tx.json.transaction.type, 'refund');
        assert.strictEqual(tx.json.transaction.reverses_txn, pay.json.result.txn_id);
        assert.strictEqual(tx.json.transaction.metadata.bits_clawed_back, 500);
        assert.strictEqual((await t.balances(buyer.id)).credit, 1000);
        const orig = await t.call('GET', `/api/v1/transactions/${pay.json.result.txn_id}`);
        assert.deepStrictEqual(orig.json.reversed_by, [tx.json.transaction.id]);
        assert.strictEqual(orig.json.transaction.entries.length, 5, 'the original stays as it was');
        t.assertReconciled('after refund');
    });

    await check('a chargeback on credit already donated leaves the payable intact and books the loss for review', async () => {
        const payer = t.user(26);
        const i = await intent({ kind: 'purchase', subject: payer, bits: 1000 });
        const pay = await t.powerchat(donation({ eventId: 'don-C', amountUsdCents: 1300, appExternalRef: i.checkout_ref }));
        assert.strictEqual(pay.json.result.effect, 'settled');
        const tip = await t.call('POST', '/api/v1/transfers', { body: { from: payer, to: streamer, amount: 800 } });
        assert.strictEqual(tip.status, 201);
        const payableBefore = (await t.balances(streamer.id)).payable;
        const cb = await t.powerchat({ type: 'donation.chargeback', streamer: { username: 'openvibe' }, data: { eventId: 'cb-1', originalEventId: 'don-C' } });
        assert.strictEqual(cb.json.result.effect, 'settled', JSON.stringify(cb.json));
        assert.strictEqual(cb.json.result.review, true);
        assert.strictEqual((await t.balances(streamer.id)).payable, payableBefore, 'recipient payable untouched');
        assert.strictEqual((await t.balances(payer.id)).credit, 0);
        const tx = (await t.call('GET', `/api/v1/transactions/${cb.json.result.txn_id}`)).json.transaction;
        assert.strictEqual(tx.type, 'chargeback');
        assert.strictEqual(tx.reverses_txn, pay.json.result.txn_id);
        assert.deepStrictEqual([tx.metadata.bits_clawed_back, tx.metadata.unrecovered_bits, tx.metadata.review], [200, 800, 'required']);
        const loss = tx.entries.find((e) => e.account.kind === 'chargeback_loss');
        assert.strictEqual(loss.amount, -1100, 'unrecovered 800 + spread 300');
        const rec = t.assertReconciled('after chargeback');
        assert.ok(rec.warnings.transactions_for_review.some((x) => x.id === tx.id));
        assert.strictEqual(rec.totals.chargeback_loss_cents, -1100);
        const again = await t.powerchat({ type: 'donation.chargeback', streamer: { username: 'openvibe' }, data: { eventId: 'cb-2', originalEventId: 'don-C' } });
        assert.strictEqual(again.json.result.effect, 'none');
        assert.strictEqual(again.json.result.reason, 'already_reversed');
    });

    await check('a refund for an unknown payment is recorded as rejected', async () => {
        const r = await t.powerchat({ type: 'donation.refunded', streamer: { username: 'openvibe' }, data: { eventId: 'rf-x', originalEventId: 'nope' } });
        assert.strictEqual(r.json.result.effect, 'rejected');
        assert.strictEqual(r.json.result.code, 'billing.original_not_found');
    });

    await check('freeze: writes answer 503 billing.frozen, reads work, webhooks are stored and processed after unfreeze', async () => {
        const pending = await intent({ kind: 'purchase', subject: buyer, bits: 100 });
        const f = await t.call('POST', '/api/v1/admin/freeze', { cap: ['billing.ledger.admin'], key: null, body: { on: true, reason: 'cutover' } });
        assert.strictEqual(f.status, 200, f.text);
        assert.strictEqual(f.json.frozen, true);
        const w = await t.call('POST', '/api/v1/transfers', { body: { from: buyer, to: streamer, amount: 1 } });
        assert.strictEqual(w.status, 503);
        assert.strictEqual(w.json.code, 'billing.frozen');
        const c = await t.call('POST', '/api/v1/cashouts', { body: { subject: streamer, amount: 600, payout_method: { type: 'paypal', address: 'a@b.co' } } });
        assert.strictEqual(c.json.code, 'billing.frozen');
        const i = await t.call('POST', '/api/v1/intents', { body: { provider: 'powerchat', kind: 'purchase', subject: buyer, bits: 100 } });
        assert.strictEqual(i.json.code, 'billing.frozen');
        assert.strictEqual((await t.call('GET', `/api/v1/balances/${buyer.id}`)).status, 200);
        assert.strictEqual((await t.call('GET', `/api/v1/entitlements/${buyer.id}?streamer=${streamer.id}`)).json.active, true);
        assert.strictEqual((await t.call('GET', '/api/health', { token: null })).json.frozen, true);
        const credit = (await t.balances(buyer.id)).credit;
        const q = await t.powerchat(donation({ eventId: 'don-F', amountUsdCents: 150, appExternalRef: pending.checkout_ref }));
        assert.strictEqual(q.status, 202);
        assert.strictEqual(q.json.queued, true);
        assert.strictEqual((await t.balances(buyer.id)).credit, credit);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM provider_events WHERE processed_at IS NULL").get().n, 1);
        const off = await t.call('POST', '/api/v1/admin/freeze', { key: null, body: { on: false } });
        assert.strictEqual(off.json.frozen, false);
        assert.strictEqual(off.json.processed_after_unfreeze.processed, 1);
        assert.strictEqual((await t.balances(buyer.id)).credit, credit + 100);
        t.assertReconciled('after unfreeze');
    });

    await t.close();
    done();
})();
