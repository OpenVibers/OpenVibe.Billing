'use strict';
/**
 * Refund of a subscription period paid from credit (plan T5 step 11, s3; money path): staff refund one whole
 * period, the credit comes back, the creator share is clawed back from the payable (what was already moved on is
 * booked to chargeback_loss, flagged for review), the period is revoked and the subscription shortened or ended;
 * a replay or a second refund never refunds twice; a promo allowance is never touched; and reconciliation's
 * subscriptions.period_charged holds every paid period to a charge record, processor reversals included.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

const DAY = 86_400_000;

(async () => {
    const t = await boot();
    const { reverseReceipt } = require('../server/ops/reversals');
    const { reconcile } = require('../server/reconcile');
    console.log('subscription refund');

    const streamer = t.user(70);
    const [fan, saver, other] = [t.user(71), t.user(72), t.user(73)];
    const ADMIN = ['billing.ledger.admin'];
    const refund = (subId, body, opts = {}) => t.call('POST', `/api/v1/subscriptions/${subId}/refund`, { body, cap: ADMIN, ...opts });
    const subscribe = async (u) => {
        const r = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: u, streamer, source: 'credit' } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json;
    };
    const ent = async (u) => (await t.call('GET', `/api/v1/entitlements/${u.id}?streamer=${streamer.id}`)).json;
    const revenueBits = async () => (await t.db.prepare(`SELECT COALESCE(SUM(e.amount), 0)::bigint AS n FROM ledger_entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.kind = 'platform_revenue' AND a.currency = 'vibes-bits'`).get()).n;
    const reversedEvents = async () => (await t.db.prepare('SELECT event FROM outbox ORDER BY seq').all()).map((r) => JSON.parse(r.event))
        .filter((e) => e.event_type === 'billing.transaction.reversed');
    const periodCheck = async () => (await reconcile(t.ctx, { store: false })).checks.find((c) => c.id === 'subscriptions.period_charged');

    // fan: two periods (first + an early renewal), and a promo allowance that must never move.
    await fund(t, fan, 998);
    const first = await subscribe(fan);
    const renewal = await subscribe(fan);
    const subId = first.subscription.id;
    const PE1 = first.subscription.current_period_end;
    const PE2 = renewal.subscription.current_period_end;
    assert.strictEqual(Date.parse(PE2) - Date.parse(PE1), 31 * DAY);
    const promo = await t.call('POST', '/api/v1/admin/promo/grant', { body: { subject: fan, bits: 300 }, cap: ADMIN });
    assert.strictEqual(promo.status, 201, promo.text);

    let refundTxn;
    await check('a refund needs billing.ledger.admin, a reason and a named period', async () => {
        const denied = await refund(subId, { period_end: PE2, reason: 'x' }, { cap: ['billing.subscription.manage'] });
        assert.strictEqual(denied.status, 403, denied.text);
        const noReason = await refund(subId, { period_end: PE2 });
        assert.strictEqual(noReason.status, 422, noReason.text);
        const noPeriod = await refund(subId, { reason: 'x' });
        assert.strictEqual(noPeriod.status, 422, noPeriod.text);
        const wrong = await refund(subId, { period_end: new Date(Date.parse(PE2) + DAY).toISOString(), reason: 'x' });
        assert.strictEqual(wrong.status, 404, wrong.text);
        assert.strictEqual(wrong.json.code, 'billing.period_not_found');
        assert.strictEqual((await t.balances(fan.id)).credit, 0, 'nothing moved');
    });

    await check('refunding the renewal returns the credit, claws back the share and shortens the membership', async () => {
        const before = { fan: await t.balances(fan.id), payable: (await t.balances(streamer.id)).payable, revenue: await revenueBits() };
        const r = await refund(subId, { period_end: PE2, reason: 'charged twice by mistake' }, { key: 'refund-renewal-1' });
        assert.strictEqual(r.status, 201, r.text);
        refundTxn = r.json.transaction;
        assert.deepStrictEqual([refundTxn.type, refundTxn.reverses_txn, refundTxn.metadata.review], ['refund', renewal.transaction.id, undefined]);
        assert.deepStrictEqual([refundTxn.metadata.bits_refunded, refundTxn.metadata.share_clawed_back_bits, refundTxn.metadata.unrecovered_share_bits], [499, 349, 0]);
        const after = await t.balances(fan.id);
        assert.strictEqual(after.credit, before.fan.credit + 499);
        assert.strictEqual(after.promo_bits, before.fan.promo_bits, 'the promo allowance is untouched');
        assert.strictEqual((await t.balances(streamer.id)).payable, before.payable - 349);
        assert.strictEqual(await revenueBits(), before.revenue - 150);
        assert.ok(!refundTxn.entries.some((e) => e.account.kind.startsWith('promo')), 'no promo account in the refund');
        assert.strictEqual(r.json.subscription.current_period_end, PE1);
        assert.strictEqual(r.json.subscription.status, 'active');
        assert.strictEqual(r.json.entitlement.active, true);
        assert.strictEqual(r.json.entitlement.expires_at, PE1);
        const ev = (await reversedEvents()).find((e) => e.subject.id === refundTxn.id);
        assert.ok(ev, 'billing.transaction.reversed enqueued');
        assert.deepStrictEqual([ev.payload.reverses_txn, ev.payload.entitlements_revoked], [renewal.transaction.id, 1]);
        await t.assertReconciled('after a credit refund');
    });

    await check('a replay, or a second refund of the same period under another key, never refunds twice', async () => {
        const credit = (await t.balances(fan.id)).credit;
        const replay = await refund(subId, { period_end: PE2, reason: 'charged twice by mistake' }, { key: 'refund-renewal-1' });
        assert.strictEqual(replay.status, 201, replay.text);
        assert.strictEqual(replay.json.transaction.id, refundTxn.id);
        const again = await refund(subId, { transaction_id: renewal.transaction.id, reason: 'again' });
        assert.strictEqual(again.status, 200, again.text);
        assert.deepStrictEqual([again.json.transaction, again.json.noop, again.json.reversed_by], [null, 'already_reversed', refundTxn.id]);
        assert.strictEqual((await t.balances(fan.id)).credit, credit);
        const n = (await t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE reverses_txn = ? AND type = 'refund'").get(renewal.transaction.id)).n;
        assert.strictEqual(n, 1);
        assert.strictEqual((await reversedEvents()).filter((e) => e.payload.reverses_txn === renewal.transaction.id).length, 1);
        await t.assertReconciled('after replays');
    });

    await check('a share the creator already moved on is booked to chargeback_loss, flagged, and the last period ends it', async () => {
        await fund(t, saver, 499);
        const s = await subscribe(saver);
        const payable = (await t.balances(streamer.id)).payable;
        const rc = await t.call('POST', '/api/v1/recycle', { body: { subject: streamer, amount: payable - 100 } });
        assert.strictEqual(rc.status, 201, rc.text);
        const r = await refund(s.subscription.id, { transaction_id: s.transaction.id, reason: 'fraud review' });
        assert.strictEqual(r.status, 201, r.text);
        const m = r.json.transaction.metadata;
        assert.deepStrictEqual([m.share_clawed_back_bits, m.unrecovered_share_bits, m.loss_cents, m.review], [100, 249, 249, 'required']);
        assert.strictEqual((await t.balances(streamer.id)).payable, 0);
        assert.strictEqual((await t.balances(saver.id)).credit, 499);
        const loss = r.json.transaction.entries.find((e) => e.account.kind === 'chargeback_loss');
        assert.strictEqual(loss.amount, -249);
        assert.strictEqual(r.json.subscription.status, 'expired');
        assert.strictEqual(r.json.subscription.auto_renew, false);
        assert.strictEqual((await ent(saver)).active, false);
        const report = await t.assertReconciled('after a refund with an unrecovered share');
        assert.ok(report.warnings.transactions_for_review.some((x) => x.id === r.json.transaction.id), 'listed for review');
    });

    await check('a period paid by a provider receipt is not refunded here; its processor reversal passes period_charged', async () => {
        const p = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: other, streamer, source: 'receipt', receipt: { provider: 'powerchat', provider_ref: 'rf1', amount_cents: 549, fee_cents: 50, route: 'site' } } });
        assert.strictEqual(p.status, 201, p.text);
        const r = await refund(p.json.subscription.id, { transaction_id: p.json.transaction.id, reason: 'x' });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json.code, 'billing.not_refundable');
        const out = await reverseReceipt(t.ctx, { kind: 'chargeback', provider: 'powerchat', originalReceiptRef: 'powerchat:rf1', reversalRef: 'powerchat:rf1:cb', idempotencyKey: 'cb-rf1', actor: { principal: 'test' }, reason: 'disputed' });
        assert.strictEqual(out.txn.type, 'chargeback');
        assert.strictEqual((await ent(other)).active, false);
        const c = await periodCheck();
        assert.strictEqual(c.ok, true, JSON.stringify(c));
        await t.assertReconciled('after a processor reversal');
    });

    await check('a renewal after a refund charges again: the refunded period end renews with a new charge', async () => {
        await fund(t, fan, 499);
        t.clock.offset += 32 * DAY;
        const sw = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.strictEqual(sw.status, 200, sw.text);
        assert.ok(sw.json.renewed.includes(subId), JSON.stringify(sw.json));
        const charge = await t.db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(`renew:${subId}:${PE1}`);
        assert.ok(charge, 'renewed from the refunded period end');
        const sub = (await t.call('GET', `/api/v1/subscriptions/${subId}`)).json.subscription;
        assert.ok(Date.parse(sub.current_period_end) > t.ctx.now() + 30 * DAY);
        await t.assertReconciled('after the renewal');
        t.clock.offset = 0;
    });

    await check('period_charged fails on a period revoked for a refund with no reversal, or granted on a reversed payment', async () => {
        const e = await t.db.prepare('SELECT id, source_txn FROM entitlements WHERE source_txn = ?').get(first.transaction.id);
        await t.db.prepare("UPDATE entitlements SET revoked_at = ?, revoked_reason = 'refund' WHERE id = ?").run(new Date().toISOString(), e.id);
        let c = await periodCheck();
        assert.strictEqual(c.ok, false);
        assert.deepStrictEqual(c.detail.offenders.map((o) => [o.entitlement, o.problem]), [[e.id, 'revoked for a refund its payment has no reversal for']]);
        await t.db.prepare('UPDATE entitlements SET revoked_at = NULL, revoked_reason = NULL WHERE id = ?').run(e.id);
        const refunded = await t.db.prepare('SELECT id FROM entitlements WHERE source_txn = ?').get(renewal.transaction.id);
        await t.db.prepare('UPDATE entitlements SET revoked_at = NULL, revoked_reason = NULL WHERE id = ?').run(refunded.id);
        c = await periodCheck();
        assert.deepStrictEqual(c.detail.offenders.map((o) => [o.entitlement, o.problem]), [[refunded.id, 'still granted though its payment was reversed']]);
        await t.db.prepare("UPDATE entitlements SET revoked_at = ?, revoked_reason = 'refund' WHERE id = ?").run(new Date().toISOString(), refunded.id);
        assert.strictEqual((await periodCheck()).ok, true);
    });

    await t.close();
    done();
})();
