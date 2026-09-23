'use strict';
/**
 * Security review regressions (Track S):
 *   - a site-routed PowerChat ref (pcorder / pcdon / site pcsub) on a tip paid to a creator's OWN
 *     PowerChat account moves no money in Billing (the ref is buyer-editable in the fallback link);
 *   - the service API is not reachable under another letter case (nginx denies /api/v1 only).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const attacker = t.user(71);           // a creator with their own PowerChat account "attackerpc"
    const victim = t.user(72);
    const attackerLiveId = 71;
    console.log('security');

    const intent = async (body) => {
        const r = await t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', ...body } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.intent;
    };
    const tipTo = (host, data) => t.powerchat({ type: 'donation.completed', streamer: { id: 'pcx', username: host }, data: { eventId: `sec-${Math.random().toString(36).slice(2)}`, ...data } });

    await check('pcdon on a tip to the creator\'s own PowerChat credits no payable', async () => {
        const r = await tipTo('attackerpc', { amountUsdCents: 5000, appExternalRef: `pcdon:${attackerLiveId}:0` });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.strictEqual(r.json.result.effect, 'none', JSON.stringify(r.json));
        assert.strictEqual(r.json.result.review, true);
        assert.strictEqual((await t.balances(attacker.id)).payable, 0);
    });

    await check('pcorder on a tip to a non-site account credits no Vibes', async () => {
        const i = await intent({ kind: 'purchase', subject: attacker, bits: 1000 });
        const r = await tipTo('attackerpc', { amountUsdCents: 1300, appExternalRef: i.checkout_ref });
        assert.strictEqual(r.json.result.effect, 'none', JSON.stringify(r.json));
        assert.strictEqual((await t.balances(attacker.id)).credit, 0);
        const after = await t.call('GET', `/api/v1/intents/${i.id}`, { cap: ['billing.intent.create'] });
        assert.notStrictEqual(after.json.intent.status, 'settled');
    });

    await check('a site-routed pcsub paid to another account grants nothing and credits no share', async () => {
        const i = await intent({ kind: 'subscription', subject: victim, streamer: attacker, route: 'site' });
        const r = await tipTo('attackerpc', { amountUsdCents: 549, appExternalRef: i.checkout_ref });
        assert.strictEqual(r.json.result.effect, 'none', JSON.stringify(r.json));
        assert.strictEqual((await t.balances(attacker.id)).payable, 0);
        const e = await t.call('GET', `/api/v1/entitlements/${victim.id}?streamer=${attacker.id}`, { cap: ['billing.entitlement.check'] });
        assert.strictEqual(e.json.active, false);
    });

    await check('the same refs paid to the site account still settle', async () => {
        const r = await tipTo('openvibe', { amountUsdCents: 250, appExternalRef: `pcdon:${attackerLiveId}:0` });
        assert.strictEqual(r.json.result.effect, 'settled', JSON.stringify(r.json));
        assert.strictEqual((await t.balances(attacker.id)).payable, 250);
        t.assertReconciled('after site pcdon');
    });

    await check('without POWERCHAT_SITE_USERNAME site-routed refs are held, never credited', async () => {
        const t2 = await boot({ network: t.network, env: { POWERCHAT_SITE_USERNAME: '' } });
        try {
            const r = await t2.powerchat({ type: 'donation.completed', streamer: { username: '' }, data: { eventId: 'sec-nosite', amountUsdCents: 900, appExternalRef: `pcdon:${attackerLiveId}:0` } });
            assert.strictEqual(r.json.result.effect, 'none', JSON.stringify(r.json));
            assert.strictEqual((await t2.balances(attacker.id)).payable, 0);
        } finally { await t2.close(); }
    });

    await check('the service API does not answer under another letter case', async () => {
        const ok = await t.call('GET', '/api/v1/rates');
        assert.strictEqual(ok.status, 200);
        for (const p of ['/API/v1/rates', '/Api/V1/rates', `/API/V1/balances/${victim.id}`]) {
            const r = await t.call('GET', p);
            assert.strictEqual(r.status, 404, `${p} answered ${r.status}`);
        }
        const w = await t.call('POST', '/API/v1/transfers', { body: { from: victim, to: attacker, amount: 1 } });
        assert.strictEqual(w.status, 404);
    });

    await t.close();
    done();
})();
