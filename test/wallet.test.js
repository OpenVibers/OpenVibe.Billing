'use strict';

const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ env: { BILLING_AUTHORITY: 'billing' } });
    const alice = t.user(301), bob = t.user(302);
    const token = t.network.signUser({ subject_id: alice.id });
    let coins = 0, history = [], down = false, requests = 0;
    t.ctx.fetchImpl = async (url, opts) => {
        if (url.endsWith('/api/payments/wallet-state')) return { ok: true, json: async () => ({ money_writes_frozen: false }) };
        requests++;
        assert.strictEqual(opts.headers.Authorization, `Bearer ${token}`);
        assert.strictEqual(opts.credentials, 'omit');
        assert.strictEqual(opts.redirect, 'error');
        assert(!url.includes('with=vibes'), 'must not loop from Network back into Billing');
        assert(url.startsWith(t.config.network.internalUrl + '/api/coins/me'));
        if (down) throw new Error('Network offline');
        return { ok: true, json: async () => url.includes('/history') ? { transactions: history } : { balance: coins } };
    };
    const read = (auth = token, headers = {}) => t.call('GET', '/api/v1/me/wallet', { token: auth, headers });
    await fund(t, bob.id, 900);
    await check('one wallet read includes all three zero balances, currency, purpose and actions', async () => {
        const r = await read();
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.subject, alice);
        for (const b of Object.values(r.json.balances)) {
            assert.strictEqual(b.amount, '0'); assert(b.currency && b.purpose && b.action);
        }
        assert.strictEqual(r.json.currency, 'USD');
        assert.strictEqual(r.json.used_ai_this_month, false);
        assert.deepStrictEqual(r.json.recent_activity, []);
        assert.match(r.headers.get('cache-control'), /private, no-store/);
    });
    await check('own balances and newest five events merge Network and Billing with site attribution', async () => {
        coins = 45;
        await fund(t, alice.id, 120);
        history = Array.from({ length: 5 }, (_, i) => ({ id: i, delta: 9, app_id: 'quest', reason: 'Media request: A film', created_at: new Date(t.ctx.now() - (i + 1) * 60000).toISOString() }));
        const r = await read();
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.balances.coins.amount, '45');
        assert.strictEqual(r.json.balances.vibes.amount, '120');
        assert.strictEqual(r.json.recent_activity.length, 5);
        assert.strictEqual(r.json.recent_activity[0].kind, 'vibes');
        assert.strictEqual(r.json.recent_activity[1].site, 'OpenVibe.Live');
        assert.strictEqual(r.json.recent_activity[1].label, 'for the stream A film');
    });
    await check('no cookies, forged tokens, service tokens or subject overrides can read another wallet', async () => {
        const before = requests;
        assert.strictEqual((await read(null, { Cookie: 'ov_token=unused' })).status, 401);
        assert.strictEqual((await read(t.network.signService({ cap: ['billing.*'] }))).status, 401);
        assert.strictEqual((await read(token + 'bad')).status, 401);
        assert.strictEqual(requests, before);
        const r = await t.call('GET', `/api/v1/me/wallet?subject=${bob.id}`, { token });
        assert.strictEqual(r.json.subject.id, alice.id);
    });
    await check('first-party bearer CORS, no credentialed cookies or tenant origins', async () => {
        const r = await read(token, { Origin: 'https://openvibe.live' });
        assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://openvibe.live');
        assert.strictEqual(r.headers.get('access-control-allow-credentials'), null);
        const bad = await read(token, { Origin: 'https://tenant.openvibe.website' });
        assert.strictEqual(bad.headers.get('access-control-allow-origin'), null);
        const pre = await t.call('OPTIONS', '/api/v1/me/wallet', { token: null, headers: { Origin: 'https://openvibe.live' } });
        assert.strictEqual(pre.status, 204);
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    });
    await check('upstream outage or invalid amount never becomes a false zero', async () => {
        down = true;
        assert.strictEqual((await read()).status, 502);
        down = false; coins = null;
        assert.strictEqual((await read()).status, 502);
        coins = 45;
    });
    await check('freeze preserves reads and shadow ledger is refused', async () => {
        await t.call('POST', '/api/v1/admin/freeze', { body: { on: true, reason: 'wallet test' } });
        const r = await read();
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.money_writes_frozen, true);
        t.config.authority = 'live';
        assert.strictEqual((await read()).status, 409);
    });
    await t.close(); done();
})();
