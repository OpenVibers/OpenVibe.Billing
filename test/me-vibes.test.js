'use strict';
// GET /api/me/vibes: a signed-in person's own Vibes for the shared navbar on every OpenVibe site (owner: "make vibes
// cross site too like opencoins"). Only once Billing is the ledger; a person's token only; CORS for OpenVibe's own sites.
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

(async () => {
    const live = await boot();
    const ann = live.user(101);
    const annToken = live.network.signUser({ subject_id: ann.id, username: 'ann' });
    const get = (t, token, headers = {}) => fetch(`${t.base}/api/me/vibes`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });

    await check('Live still the ledger: the balance is a shadow, so 409 and the chip stays hidden', async () => {
        const r = await get(live, annToken);
        assert.strictEqual(r.status, 409);
        assert.strictEqual((await r.json()).code, 'billing.not_authoritative');
    });
    await live.close();

    const t = await boot({ env: { BILLING_AUTHORITY: 'billing' } });
    const bob = t.user(102);
    const bobToken = t.network.signUser({ subject_id: bob.id, username: 'bob' });
    await fund(t, bob.id, 500);

    await check('the person reads their own Vibes with their token; nothing is cached', async () => {
        const r = await get(t, bobToken);
        assert.strictEqual(r.status, 200);
        const j = await r.json();
        assert.deepStrictEqual(j.subject, { type: 'user', id: bob.id });
        assert.strictEqual(j.credit, 500);
        assert.strictEqual(j.payable, 0);
        assert.strictEqual(j.currency, 'vibes-bits');
        assert.match(r.headers.get('cache-control'), /private, no-store/);
    });

    await check('no token, a service token or a forged one: 401', async () => {
        assert.strictEqual((await get(t, null)).status, 401);
        assert.strictEqual((await get(t, t.network.signService({ cap: ['billing.*'] }))).status, 401, 'a service token is not a person');
        assert.strictEqual((await get(t, `${bobToken.slice(0, -4)}AAAA`)).status, 401);
    });

    await check('CORS: an OpenVibe site gets its origin back, any other site none; preflight allows Authorization', async () => {
        const own = await get(t, bobToken, { Origin: 'https://openvibe.tips' });
        assert.strictEqual(own.headers.get('access-control-allow-origin'), 'https://openvibe.tips');
        assert.match(own.headers.get('vary') || '', /Origin/);
        const foreign = await get(t, bobToken, { Origin: 'https://evil.example' });
        assert.strictEqual(foreign.headers.get('access-control-allow-origin'), null);
        const tenant = await get(t, bobToken, { Origin: 'https://someone.openvibe.website' });
        assert.strictEqual(tenant.headers.get('access-control-allow-origin'), null, 'a hosting tenant is not OpenVibe');
        const pre = await fetch(`${t.base}/api/me/vibes`, { method: 'OPTIONS', headers: { Origin: 'https://openvibe.live', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
        assert.strictEqual(pre.status, 204);
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
        assert.strictEqual(pre.headers.get('access-control-allow-credentials'), null, 'no cookies');
    });

    await t.close();
    done();
})();
