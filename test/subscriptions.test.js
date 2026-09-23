'use strict';
/**
 * Subscriptions paid from credit: the creator share on every period (first and renewals),
 * entitlements, the renewal sweep, cancel-at-period-end, and entitlement reads that need nothing
 * but Billing (Live and even the Network may be down).
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

const DAY = 86_400_000;

(async () => {
    const t = await boot();
    const fan = t.user(31);
    const streamer = t.user(32);
    console.log('subscriptions');

    let sub;
    await check('subscribing from credit credits the streamer share and grants an entitlement', async () => {
        await fund(t, fan, 1000);
        const r = await t.call('POST', '/api/v1/subscriptions', { cap: ['billing.subscription.manage'], body: { subscriber: fan, streamer, source: 'credit' } });
        assert.strictEqual(r.status, 201, r.text);
        sub = r.json.subscription;
        assert.strictEqual(sub.status, 'active');
        assert.strictEqual(sub.auto_renew, true);
        const m = r.json.transaction.metadata;
        assert.deepStrictEqual([m.cost_bits, m.share_bits, m.renewal], [499, 349, false]);
        assert.strictEqual((await t.balances(fan.id)).credit, 501);
        assert.strictEqual((await t.balances(streamer.id)).payable, 349);
        const rev = r.json.transaction.entries.find((e) => e.account.kind === 'platform_revenue');
        assert.strictEqual(rev.amount, 150);
        assert.strictEqual(r.json.entitlement.active, true);
        assert.ok(Math.abs(Date.parse(r.json.entitlement.expires_at) - (Date.now() + 31 * DAY)) < 60_000);
        t.assertReconciled('after credit sub');
    });

    await check('an early renewal credits the share again and extends the entitlement', async () => {
        const before = Date.parse((await t.call('GET', `/api/v1/entitlements/${fan.id}?streamer=${streamer.id}`)).json.expires_at);
        const r = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: fan, streamer, source: 'credit' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.transaction.metadata.renewal, true);
        assert.strictEqual((await t.balances(streamer.id)).payable, 698);
        const after = Date.parse(r.json.entitlement.expires_at);
        assert.strictEqual(after - before, 31 * DAY);
        t.assertReconciled('after renewal');
    });

    await check('insufficient credit refuses a subscription and changes nothing', async () => {
        const r = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: fan, streamer, source: 'credit' } });
        assert.strictEqual(r.status, 409);
        assert.strictEqual(r.json.code, 'billing.insufficient_funds');
    });

    await check('a receipt-paid subscription through the API needs billing.ledger.admin', async () => {
        const r = await t.call('POST', '/api/v1/subscriptions', { cap: ['billing.subscription.manage'], body: { subscriber: t.user(33), streamer, source: 'receipt', receipt: { provider: 'powerchat', provider_ref: 'x1', amount_cents: 549, fee_cents: 50, route: 'site' } } });
        assert.strictEqual(r.status, 403);
        const ok = await t.call('POST', '/api/v1/subscriptions', { cap: ['billing.subscription.manage', 'billing.ledger.admin'], body: { subscriber: t.user(33), streamer, source: 'receipt', receipt: { provider: 'powerchat', provider_ref: 'x1', amount_cents: 549, fee_cents: 50, route: 'site' } } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.strictEqual(ok.json.transaction.metadata.share_bits, 349);
    });

    await check('the renewal sweep renews from credit (share credited) and ends unaffordable subs', async () => {
        await fund(t, fan, 499 - 2); // exactly one more period (2 bits left + 497)
        t.clock.offset = 63 * DAY;   // both paid periods are over
        const s1 = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.strictEqual(s1.status, 200, s1.text);
        assert.deepStrictEqual(s1.json.renewed, [sub.id]);
        assert.strictEqual((await t.balances(streamer.id)).payable, 698 + 349 + 349);
        assert.strictEqual((await t.balances(fan.id)).credit, 0);
        t.clock.offset = 95 * DAY;
        const s2 = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.deepStrictEqual(s2.json.expired, [sub.id]);
        const e = await t.call('GET', `/api/v1/entitlements/${fan.id}?streamer=${streamer.id}`);
        assert.strictEqual(e.json.active, false);
        assert.strictEqual(e.json.subscription.status, 'expired');
        t.clock.offset = 0;
        t.assertReconciled('after sweeps');
    });

    await check('cancel keeps access until the period ends, then the sweep ends it', async () => {
        const f2 = t.user(34);
        await fund(t, f2, 499);
        const s = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: f2, streamer, source: 'credit' } });
        const c = await t.call('POST', `/api/v1/subscriptions/${s.json.subscription.id}/cancel`, { cap: ['billing.subscription.manage'], body: {} });
        assert.strictEqual(c.status, 200, c.text);
        assert.strictEqual(c.json.subscription.cancel_at_period_end, true);
        assert.strictEqual(c.json.subscription.auto_renew, false);
        assert.strictEqual(c.json.provider_sync, 'not_needed');
        assert.strictEqual((await t.call('GET', `/api/v1/entitlements/${f2.id}?streamer=${streamer.id}`)).json.active, true);
        t.clock.offset = 32 * DAY;
        const sw = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.ok(sw.json.canceled.includes(s.json.subscription.id));
        assert.strictEqual((await t.call('GET', `/api/v1/entitlements/${f2.id}?streamer=${streamer.id}`)).json.active, false);
        t.clock.offset = 0;
    });

    await check('entitlements are answered by Billing alone, with Live absent and the Network down', async () => {
        t.network.state.down = true;
        const f3 = t.user(35);
        await fund(t, f3, 499);
        await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: f3, streamer, source: 'credit' } });
        const one = await t.call('GET', `/api/v1/entitlements/${f3.id}?streamer=${streamer.id}`, { cap: ['billing.entitlement.check'] });
        assert.strictEqual(one.status, 200);
        assert.strictEqual(one.json.active, true);
        const all = await t.call('GET', `/api/v1/entitlements/${f3.id}`, { cap: ['billing.entitlement.check'] });
        assert.strictEqual(all.json.entitlements.length, 1);
        assert.strictEqual(all.json.entitlements[0].streamer.id, streamer.id);
        const list = await t.call('GET', `/api/v1/subscriptions?streamer=${streamer.id}&status=active`, { cap: ['billing.entitlement.check'] });
        assert.ok(list.json.subscriptions.some((s) => s.subscriber.id === f3.id));
        t.network.state.down = false;
    });

    await t.close();
    done();
})();
