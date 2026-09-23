'use strict';
/**
 * The operations API end to end: purchases, transfers, recycle, cashouts, refunds of transfers,
 * idempotent replays — with a full reconciliation after every operation type.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const viewer = t.user(11);
    const streamer = t.user(12);
    console.log('operations');

    await check('health and rates are served', async () => {
        const h = await t.call('GET', '/api/health', { token: null });
        assert.strictEqual(h.status, 200);
        assert.strictEqual(h.json.frozen, false);
        assert.deepStrictEqual(h.json.providers, { powerchat: true, stripe: false, paypal: false, ccbill: false, nowpayments: false });
        const r = await t.call('GET', '/api/v1/rates', { token: null });
        assert.strictEqual(r.json.packages.find((p) => p.bits === 1000).price_cents, 1300);
        assert.strictEqual((await t.call('GET', '/api/ready', { token: null })).status, 200);
    });

    await check('purchase settle credits the buyer and books the spread as revenue', async () => {
        const r = await t.call('POST', '/api/v1/purchases/settle', { body: { provider: 'powerchat', provider_ref: 'pay-1', subject: viewer, amount_cents: 1300 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.transaction.metadata.bits, 1000);
        assert.strictEqual(r.json.transaction.metadata.revenue_cents, 300);
        assert.strictEqual(r.json.transaction.metadata.rates.bits_per_usd, 100);
        assert.strictEqual((await t.balances(viewer.id)).credit, 1000);
        t.assertReconciled('after purchase');
    });

    await check('the same provider payment settles once, whatever key carries it', async () => {
        const r = await t.call('POST', '/api/v1/purchases/settle', { body: { provider: 'powerchat', provider_ref: 'pay-1', subject: viewer, amount_cents: 1300 } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.duplicate_receipt, true);
        assert.strictEqual((await t.balances(viewer.id)).credit, 1000);
    });

    let donation;
    await check('a transfer moves credit into the creator payable', async () => {
        const r = await t.call('POST', '/api/v1/transfers', {
            key: 'tip-key-0001', cap: ['billing.transfer.create'],
            body: { from: viewer, to: streamer, amount: 400, kind: 'tip', message: 'gg', target: { service: 'live', type: 'stream', id: '77' } },
        });
        assert.strictEqual(r.status, 201, r.text);
        donation = r.json.transaction;
        assert.strictEqual(donation.type, 'donation');
        assert.deepStrictEqual(donation.metadata.target, { service: 'live', type: 'stream', id: '77' });
        assert.strictEqual(r.json.balance.credit, 600);
        assert.strictEqual((await t.balances(streamer.id)).payable, 400);
        t.assertReconciled('after transfer');
    });

    await check('replaying an Idempotency-Key returns the original response and moves nothing', async () => {
        const r = await t.call('POST', '/api/v1/transfers', {
            key: 'tip-key-0001', cap: ['billing.transfer.create'],
            body: { from: viewer, to: streamer, amount: 400, kind: 'tip', message: 'gg', target: { service: 'live', type: 'stream', id: '77' } },
        });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.headers.get('idempotent-replayed'), 'true');
        assert.strictEqual(r.json.transaction.id, donation.id);
        assert.strictEqual((await t.balances(viewer.id)).credit, 600);
        const other = await t.call('POST', '/api/v1/transfers', { key: 'tip-key-0001', cap: ['billing.transfer.create'], body: { from: viewer, to: streamer, amount: 1 } });
        assert.strictEqual(other.status, 422);
        assert.strictEqual(other.json.code, 'idempotency.key_reused');
    });

    await check('mutating calls without an Idempotency-Key are refused', async () => {
        const r = await t.call('POST', '/api/v1/transfers', { key: null, body: { from: viewer, to: streamer, amount: 1 } });
        assert.strictEqual(r.status, 400);
        assert.strictEqual(r.json.code, 'idempotency.key_required');
    });

    await check('self-dealing is refused by subject', async () => {
        const r = await t.call('POST', '/api/v1/transfers', { body: { from: viewer, to: { type: 'user', id: viewer.id }, amount: 10 } });
        assert.strictEqual(r.status, 422);
        assert.strictEqual(r.json.code, 'billing.self_dealing');
        const sub = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: viewer, streamer: viewer, source: 'credit' } });
        assert.strictEqual(sub.json.code, 'billing.self_dealing');
    });

    await check('insufficient funds are refused atomically', async () => {
        const r = await t.call('POST', '/api/v1/transfers', { body: { from: viewer, to: streamer, amount: 601 } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'billing.insufficient_funds');
        assert.strictEqual(r.json.details.available, 600);
        assert.strictEqual((await t.balances(viewer.id)).credit, 600);
        assert.strictEqual((await t.balances(streamer.id)).payable, 400);
    });

    await check('bought credit cannot be cashed out by its buyer', async () => {
        const r = await t.call('POST', '/api/v1/cashouts', { body: { subject: viewer, amount: 500, payout_method: { type: 'paypal', address: 'v@example.com' } } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'billing.insufficient_funds');
    });

    await check('a credit-funded transfer can be refunded to its giver (media request that never played)', async () => {
        const r = await t.call('POST', `/api/v1/transfers/${donation.id}/refund`, { body: { amount: 100, reason: 'request failed' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.transaction.reverses_txn, donation.id);
        assert.strictEqual((await t.balances(viewer.id)).credit, 700);
        assert.strictEqual((await t.balances(streamer.id)).payable, 300);
        const over = await t.call('POST', `/api/v1/transfers/${donation.id}/refund`, { body: { amount: 301 } });
        assert.strictEqual(over.json.code, 'billing.already_reversed');
        const tx = await t.call('GET', `/api/v1/transactions/${donation.id}`);
        assert.deepStrictEqual(tx.json.reversed_by, [r.json.transaction.id]);
        t.assertReconciled('after transfer refund');
    });

    await check('recycle moves payable back to spendable credit as a journal entry', async () => {
        const r = await t.call('POST', '/api/v1/recycle', { body: { subject: streamer, amount: 50 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.transaction.type, 'recycle');
        assert.deepStrictEqual([r.json.balance.credit, r.json.balance.payable], [50, 250]);
        t.assertReconciled('after recycle');
    });

    let cashout;
    await check('cashout: minimum enforced, then payable goes to escrow', async () => {
        await fund(t, viewer, 5000);
        const tip = await t.call('POST', '/api/v1/transfers', { body: { from: viewer, to: streamer, amount: 1000 } });
        assert.strictEqual(tip.status, 201);
        const small = await t.call('POST', '/api/v1/cashouts', { body: { subject: streamer, amount: 100, payout_method: { type: 'paypal', address: 's@example.com' } } });
        assert.strictEqual(small.json.code, 'billing.amount_too_small');
        const r = await t.call('POST', '/api/v1/cashouts', { cap: ['billing.cashout.request'], body: { subject: streamer, amount: 1000, payout_method: { type: 'paypal', address: 's@example.com' } } });
        assert.strictEqual(r.status, 201, r.text);
        cashout = r.json.cashout;
        assert.strictEqual(cashout.status, 'requested');
        assert.strictEqual(cashout.value_cents, 1000);
        const b = await t.balances(streamer.id);
        assert.deepStrictEqual([b.payable, b.pending_payouts], [250, 1000]);
        t.assertReconciled('after cashout request');
    });

    await check('approval needs a payout reference and waits for the escrow period', async () => {
        const noRef = await t.call('POST', `/api/v1/cashouts/${cashout.id}/approve`, { cap: ['billing.cashout.manage'], body: {} });
        assert.strictEqual(noRef.json.code, 'billing.payout_reference_required');
        const early = await t.call('POST', `/api/v1/cashouts/${cashout.id}/approve`, { cap: ['billing.cashout.manage'], body: { payout_reference: 'PAYPAL-BATCH-1' } });
        assert.strictEqual(early.status, 409);
        assert.strictEqual(early.json.code, 'billing.escrow_active');
        const denied = await t.call('POST', `/api/v1/cashouts/${cashout.id}/approve`, { cap: ['billing.cashout.request'], body: { payout_reference: 'X' } });
        assert.strictEqual(denied.status, 403);
        t.clock.offset = 15 * 86_400_000;
        const ok = await t.call('POST', `/api/v1/cashouts/${cashout.id}/approve`, { cap: ['billing.cashout.manage'], body: { payout_reference: 'PAYPAL-BATCH-1' } });
        t.clock.offset = 0;
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json.cashout.status, 'paid');
        assert.strictEqual(ok.json.cashout.payout_reference, 'PAYPAL-BATCH-1');
        assert.strictEqual((await t.balances(streamer.id)).pending_payouts, 0);
        const r = t.assertReconciled('after payout');
        assert.strictEqual(r.checks.find((c) => c.id === 'payouts.references').ok, true);
    });

    await check('a denied cashout returns to the creator payable as a reversal', async () => {
        assert.strictEqual((await t.call('POST', '/api/v1/transfers', { body: { from: viewer, to: streamer, amount: 500 } })).status, 201);
        const r = await t.call('POST', '/api/v1/cashouts', { body: { subject: streamer, amount: 500, payout_method: { type: 'paypal', address: 's@example.com' } } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual((await t.balances(streamer.id)).payable, 250);
        const d = await t.call('POST', `/api/v1/cashouts/${r.json.cashout.id}/deny`, { body: { reason: 'suspicious' } });
        assert.strictEqual(d.status, 200, d.text);
        assert.strictEqual(d.json.cashout.status, 'denied');
        const b = await t.balances(streamer.id);
        assert.deepStrictEqual([b.payable, b.pending_payouts], [750, 0]);
        const tx = await t.call('GET', `/api/v1/transactions/${d.json.cashout.settle_txn}`);
        assert.strictEqual(tx.json.transaction.reverses_txn, r.json.cashout.request_txn);
        const list = await t.call('GET', '/api/v1/cashouts?status=denied', { cap: ['billing.cashout.manage'] });
        assert.strictEqual(list.json.cashouts.length, 1);
        t.assertReconciled('after deny');
    });

    await check('an operator adjustment is a balanced transaction with a reason', async () => {
        const noReason = await t.call('POST', '/api/v1/admin/adjustments', { cap: ['billing.ledger.admin'], body: { from: { kind: 'chargeback_loss', currency: 'usd-cents' }, to: { kind: 'refunds', currency: 'usd-cents' }, amount: 5 } });
        assert.strictEqual(noReason.status, 422);
        const mixed = await t.call('POST', '/api/v1/admin/adjustments', { body: { from: { kind: 'import_adjustment', currency: 'vibes-bits' }, to: { kind: 'refunds', currency: 'usd-cents' }, amount: 5, reason: 'x' } });
        assert.strictEqual(mixed.status, 422);
        const r = await t.call('POST', '/api/v1/admin/adjustments', { cap: ['billing.ledger.admin'], body: { from: { kind: 'import_adjustment', currency: 'vibes-bits' }, to: { kind: 'user_credit', owner: viewer.id, currency: 'vibes-bits' }, amount: 5, reason: 'goodwill after outage' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.transaction.type, 'adjustment');
        assert.strictEqual(r.json.transaction.metadata.reason, 'goodwill after outage');
        t.assertReconciled('after adjustment');
        const denied = await t.call('POST', '/api/v1/admin/adjustments', { cap: ['billing.transfer.create'], body: {} });
        assert.strictEqual(denied.status, 403);
    });

    await check('transaction history pages by cursor', async () => {
        const all = [];
        let cursor = null;
        do {
            const r = await t.call('GET', `/api/v1/transactions?subject=${streamer.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
            assert.strictEqual(r.status, 200, r.text);
            all.push(...r.json.transactions);
            cursor = r.json.next_cursor;
        } while (cursor);
        assert.ok(all.length >= 7, `got ${all.length}`);
        assert.strictEqual(new Set(all.map((x) => x.id)).size, all.length);
    });

    await t.close();
    done();
})();
