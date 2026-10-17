'use strict';
/**
 * Creator-priced subscription tiers (openvibe-contracts 0.201.0, billing.tier.manage; server/ops/tiers.js): the product
 * that sells memberships sets each tier's monthly price within Billing's bounds, and Billing charges it on a credit
 * period, a PowerChat checkout (the tier rides on the intent) and renewals (at the price bought at). Tier 1 without a
 * price stays the site price; an unknown or archived tier is not for sale; no switching tiers mid-period.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, fund, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BILLING_RENEWAL_GRACE_DAYS: '0' } });
    const creator = t.user(41);
    const fan = t.user(42);
    const other = t.user(43);
    console.log('subscription tiers');
    const put = (tier, body, cap = ['billing.tier.manage']) => t.call('PUT', `/api/v1/tiers/${creator.id}/${tier}`, { cap, body, headers: { 'Idempotency-Key': `tier-${crypto.randomUUID()}` } });
    const list = (cap = ['billing.tier.manage']) => t.call('GET', `/api/v1/tiers/${creator.id}`, { cap });

    await check('no tiers yet: tier 1 is the site price; the bounds are published', async () => {
        const r = await list(['billing.intent.create']);
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.tiers, []);
        assert.deepStrictEqual([r.json.default_price_cents, r.json.min_price_cents, r.json.max_price_cents, r.json.max_tiers], [499, 100, 50000, 10]);
        const rates = await t.call('GET', '/api/v1/rates', { token: null });
        assert.deepStrictEqual(rates.json.subscription.tiers, { min_price_cents: 100, max_price_cents: 50000, max_tiers: 10 });
    });

    await check('setting a price needs billing.tier.manage, an Idempotency-Key and a price within the bounds', async () => {
        assert.strictEqual((await put(2, { price_cents: 1500 }, ['billing.intent.create'])).status, 403);
        const noKey = await t.call('PUT', `/api/v1/tiers/${creator.id}/2`, { cap: ['billing.tier.manage'], body: { price_cents: 1500 } });
        assert.strictEqual(noKey.status, 400, noKey.text);
        assert.strictEqual((await put(2, { price_cents: 99 })).json.code, 'billing.invalid_amount');
        assert.strictEqual((await put(2, { price_cents: 50001 })).json.code, 'billing.invalid_amount');
        assert.strictEqual((await put(11, { price_cents: 1500 })).json.code, 'billing.invalid_input');
        assert.strictEqual((await put(2, { price_cents: 1500, status: 'paused' })).json.code, 'billing.invalid_input');
        const ok = await put(2, { price_cents: 1500 });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.deepStrictEqual([ok.json.tier.tier, ok.json.tier.price_cents, ok.json.tier.status], [2, 1500, 'active']);
        assert.strictEqual((await put(1, { price_cents: 300 })).status, 200);
        assert.deepStrictEqual((await list()).json.tiers.map((x) => [x.tier, x.price_cents]), [[1, 300], [2, 1500]]);
    });

    await check('a credit period costs the tier price; the share follows it; the entitlement names the tier', async () => {
        await fund(t, fan, 3000);
        const r = await t.call('POST', '/api/v1/subscriptions', { cap: ['billing.subscription.manage'], body: { subscriber: fan, streamer: creator, source: 'credit', tier: 2 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.subscription.tier, 2);
        assert.strictEqual(r.json.subscription.price_cents, 1500);
        const m = r.json.transaction.metadata;
        assert.deepStrictEqual([m.tier, m.cost_bits, m.share_bits], [2, 1500, 1050]);
        assert.strictEqual(r.json.entitlement.tier, 2);
        const e = await t.call('GET', `/api/v1/entitlements/${fan.id}?streamer=${creator.id}`, { cap: ['billing.entitlement.check'] });
        assert.deepStrictEqual([e.json.active, e.json.tier], [true, 2]);
        await t.assertReconciled('after a tier-2 period');
    });

    await check('no switching tiers while a period runs (credit or checkout); the same tier renews early as before', async () => {
        const sw = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: fan, streamer: creator, source: 'credit', tier: 1 } });
        assert.strictEqual(sw.status, 409, sw.text);
        assert.strictEqual(sw.json.code, 'billing.tier_change_unsupported');
        const ck = await t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', kind: 'subscription', subject: fan, streamer: creator, tier: 1 } });
        assert.strictEqual(ck.json.code, 'billing.tier_change_unsupported');
        const again = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: fan, streamer: creator, source: 'credit', tier: 2 } });
        assert.strictEqual(again.status, 201, again.text);
        assert.strictEqual(again.json.transaction.metadata.renewal, true);
    });

    await check('a PowerChat checkout is priced by the tier and grants it on settlement', async () => {
        const i = await t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', kind: 'subscription', subject: other, streamer: creator, tier: 2, route: 'site' } });
        assert.strictEqual(i.status, 201, i.text);
        assert.deepStrictEqual([i.json.intent.tier, i.json.intent.amount_cents, i.json.intent.fee_cents], [2, 1650, 150]);
        const r = await t.powerchat({ type: 'donation.completed', streamer: { id: 'pc1', username: 'openvibe' }, data: { eventId: `don-${crypto.randomUUID()}`, amountUsdCents: 1650, appExternalRef: i.json.intent.checkout_ref } });
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));
        const e = await t.call('GET', `/api/v1/entitlements/${other.id}?streamer=${creator.id}`);
        assert.deepStrictEqual([e.json.active, e.json.tier], [true, 2]);
        const s = await t.call('GET', `/api/v1/subscriptions/${e.json.subscription.id}`);
        assert.deepStrictEqual([s.json.subscription.tier, s.json.subscription.price_cents], [2, 1500]);
        await t.assertReconciled('after a tier-2 checkout');
    });

    await check('unknown and archived tiers are not for sale; tier 1 keeps its price', async () => {
        const nobody = t.user(44);
        await fund(t, nobody, 2000);
        const unknown = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: nobody, streamer: creator, source: 'credit', tier: 3 } });
        assert.strictEqual(unknown.json.code, 'billing.tier_unknown');
        assert.strictEqual((await put(2, { price_cents: 1500, status: 'archived' })).status, 200);
        const archived = await t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', kind: 'subscription', subject: nobody, streamer: creator, tier: 2 } });
        assert.strictEqual(archived.json.code, 'billing.tier_archived');
        const one = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: nobody, streamer: creator, source: 'credit' } });
        assert.strictEqual(one.status, 201, one.text);
        assert.deepStrictEqual([one.json.subscription.tier, one.json.subscription.price_cents, one.json.transaction.metadata.cost_bits], [1, 300, 300]);
    });

    await check('a renewal keeps the tier and the price it was bought at, even after the creator changes it', async () => {
        assert.strictEqual((await put(2, { price_cents: 2500 })).status, 200);
        const sub = (await t.call('GET', `/api/v1/subscriptions?subscriber=${fan.id}&streamer=${creator.id}`)).json.subscriptions[0];
        await fund(t, fan, 1500);
        t.clock.offset = Date.parse(sub.current_period_end) - Date.now() + 1000;
        const { sweep } = require('../server/ops/subscriptions');
        const out = await sweep(t.ctx);
        assert.ok(out.renewed.includes(sub.id), JSON.stringify(out));
        const after = (await t.call('GET', `/api/v1/subscriptions/${sub.id}`)).json.subscription;
        assert.deepStrictEqual([after.tier, after.price_cents], [2, 1500]);
        await t.assertReconciled('after a tier-2 renewal');
    });

    await t.close();
    done();
})();
