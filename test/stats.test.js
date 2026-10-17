'use strict';
/**
 * GET /api/v1/stats (openvibe-contracts 0.203.0, billing.stats.read; server/ops/stats.js): network-wide counts with no
 * person in them. Vibes bought (all time, windows, a daily series) and subscriptions (active now, started: renewals are
 * not new ones), with test rows left out; the capability is required; the answer names nobody.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BILLING_RENEWAL_GRACE_DAYS: '0' } });
    const a = t.user(71);
    const b = t.user(72);
    const creator = t.user(73);
    const get = (q = '', cap = ['billing.stats.read']) => t.call('GET', `/api/v1/stats${q}`, { cap });

    await check('nothing yet: zeros, and a series of the asked length', async () => {
        const r = await get('?days=7');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.purchases.bits_total, 0);
        assert.strictEqual(r.json.subscriptions.active, 0);
        assert.strictEqual(r.json.purchases.series.length, 7);
        assert.deepStrictEqual(r.json.purchases.windows, { d: 0, w: 0, m: 0, pw: 0 });
    });

    await check('purchases and a first subscription count; an early renewal does not start a new one', async () => {
        await fund(t, a, 1500);
        await fund(t, b, 600);
        assert.strictEqual((await t.call('POST', '/api/v1/subscriptions', { cap: ['billing.subscription.manage'], body: { subscriber: a, streamer: creator, source: 'credit' } })).status, 201);
        assert.strictEqual((await t.call('POST', '/api/v1/subscriptions', { cap: ['billing.subscription.manage'], body: { subscriber: a, streamer: creator, source: 'credit' } })).status, 201, 'an early renewal');
        const r = await get();
        assert.strictEqual(r.json.purchases.bits_total, 2100);
        assert.deepStrictEqual(r.json.purchases.windows, { d: 2100, w: 2100, m: 2100, pw: 0 });
        assert.strictEqual(r.json.purchases.series.at(-1).value, 2100, "today's bucket");
        assert.strictEqual(r.json.subscriptions.active, 1);
        assert.deepStrictEqual(r.json.subscriptions.windows, { d: 1, w: 1, m: 1, pw: 0 });
        assert.ok(!JSON.stringify(r.json).includes('usr_'), 'no person in the answer');
    });

    await check('the capability is required', async () => {
        assert.strictEqual((await get('', ['billing.entitlement.check'])).status, 403);
    });

    await t.close();
    done();
})();
