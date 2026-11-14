'use strict';
/**
 * The checkout providers in the Money group (owner-setup design, plan §AB.16 and §AB.18): PayPal,
 * Coinbase Commerce, Square, Paddle and Lemon Squeezy, one row each with its keys, its test/live
 * switch and its webhook signing secret.
 *
 * Proves: every provider is one row of the Setup tab (one x-required-for its fields share), the row
 * says in plain words what it unlocks and where the key is made, and every field has a title and a
 * 30+ character description; the keys are write-only and sealed in the vault; the test hook answers
 * from the provider's own recorded answers with one cheap authenticated read and never spends; the
 * webhook endpoint verifies the provider's own signature and records the event without moving money;
 * no key is in a log line, a console line or an answer.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const { lintSchema } = require('./helpers/lint-schema');
const { PAYMENT_PROVIDERS } = require('../server/config-store');

const CAP = ['billing.config.manage'];
const KEK = 'k1:' + crypto.randomBytes(32).toString('base64');
const NS = 'billing.payments';
// Made-up keys, built at run time so a secret scanner never reads a provider-shaped string in the source.
const key = (name) => `madeUp${name}NEVERSHOWN7c41`;
const SECRETS = {
    paypal: { client_id: key('PayPalClientId'), client_secret: key('PayPalClientSecret'), webhook_id: key('PaypalWebhookId') },
    coinbase: { api_key: key('CoinbaseApiKey'), webhook_secret: key('CoinbaseWebhookSecret') },
    square: { access_token: key('SquareAccessToken'), signature_key: key('SquareSignatureKey') },
    paddle: { api_key: key('PaddleApiKey'), webhook_secret: key('PaddleWebhookSecret') },
    lemon_squeezy: { api_key: key('LemonApiKey'), webhook_secret: key('LemonWebhookSecret') },
};

/** The providers' recorded answers: one cheap authenticated read each, never a charge. */
const RECORDED = {
    paypal: (url) => url.endsWith('/v1/oauth2/token')
        ? { status: 200, json: { access_token: 'recorded-token', token_type: 'Bearer' } }
        : { status: 200, json: { webhooks: [{ id: 'WH-1' }, { id: 'WH-2' }] } },
    // Coinbase Commerce answers 401 for a key it does not know, exactly as the live API does.
    coinbase: (url, opts) => (opts && opts.headers && opts.headers['x-cc-api-key'] === SECRETS.coinbase.api_key)
        ? { status: 200, json: { data: [{ id: 'ch-1' }] } }
        : { status: 401, json: { message: 'Invalid API key' } },
    square: () => ({ status: 200, json: { locations: [{ name: 'Main' }] } }),
    paddle: () => ({ status: 200, json: { data: [{ id: 'pri_1' }] } }),
    lemon_squeezy: () => ({ status: 200, json: { data: [{ id: 'st_1', name: 'Store' }] } }),
};

(async () => {
    console.log('owner inputs (billing.payments)');
    const consoleLines = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(original)) console[k] = (...a) => { consoleLines.push(a.join(' ')); original[k](...a); };

    // The providers' answers are recorded: the test never reaches a provider over the network.
    const fetchImpl = async (url, opts) => {
        const href = String(url);
        const host = /paypal/.test(href) ? 'paypal' : /coinbase/.test(href) ? 'coinbase' : /square/.test(href) ? 'square'
            : /paddle/.test(href) ? 'paddle' : /lemonsqueezy/.test(href) ? 'lemon_squeezy' : null;
        if (!host) return globalThis.fetch(url, opts);
        const out = RECORDED[host](href, opts);
        return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.json, headers: { get: () => null } };
    };

    const t = await boot({ env: { OV_CONFIG_KEKS: KEK, OV_CONFIG_KEK_CURRENT: 'k1' }, fetchImpl });
    const owner = t.user(601);
    const headers = { 'x-ov-subject': owner.id, 'x-ov-fresh': '1' };
    const cfg = (method, path, body) => t.call(method, path, { cap: CAP, headers, body, key: null });
    const put = (k, value) => cfg('PUT', `/internal/config/${NS}/secrets/${k}`, { value, reason: 'setup' });
    const test = (k) => cfg('POST', `/internal/config/${NS}/test/${k}`);

    await check('every provider is one row: its fields share one x-required-for and one group', async () => {
        const r = await cfg('GET', `/internal/config/${NS}`);
        assert.strictEqual(r.status, 200, r.text);
        const props = r.json.schema.properties;
        assert.deepStrictEqual(lintSchema(r.json.schema), [], `${NS}: ${lintSchema(r.json.schema).join('; ')}`);
        for (const provider of PAYMENT_PROVIDERS) {
            const required = new Set(provider.keys.map((k) => props[k.name]['x-required-for']));
            assert.strictEqual(required.size, 1, `${provider.title} is one row: ${[...required].join(', ')}`);
            assert.ok(required.has(provider.requiredFor));
            for (const k of provider.keys) {
                const f = props[k.name];
                assert.strictEqual(f['x-owner-input'].group, 'money', k.name);
                assert.ok(f['x-owner-input'].unlocks.length > 20, k.name);
                assert.match(f['x-owner-input'].get_it_at, /^https:\/\//, k.name);
                assert.ok(f['x-owner-input'].get_it_how.length > 10, k.name);
                assert.strictEqual(typeof f['x-owner-input'].test, 'boolean', k.name);
                assert.ok(f.title && f.description.length >= 30, k.name);
            }
            // One row, one test: exactly one field of the provider carries the test.
            assert.strictEqual(provider.keys.filter((k) => k.test).length, 1, provider.title);
            // The row says what it unlocks in plain words, and that checkout comes later.
            assert.match(provider.unlocks, /checkout/i, provider.title);
        }
    });

    await check('the keys are write-only and sealed, and the live switch needs a fresh sign-in', async () => {
        for (const provider of PAYMENT_PROVIDERS) {
            for (const k of provider.keys.filter((x) => x.secret)) {
                const r = await put(k.name, SECRETS[provider.id][k.name.split('.').slice(1).join('.')]);
                assert.strictEqual(r.status, 200, r.text);
                assert.ok(!r.text.includes(SECRETS[provider.id][k.name.split('.').slice(1).join('.')]), k.name);
            }
        }
        const summary = await cfg('GET', `/internal/config/${NS}`);
        for (const provider of PAYMENT_PROVIDERS) {
            for (const k of provider.keys.filter((x) => x.secret)) {
                assert.ok(summary.json.values[k.name].redacted, k.name);
                assert.ok(!summary.text.includes(SECRETS[provider.id][k.name.split('.').slice(1).join('.')]), k.name);
            }
        }
        const row = await t.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = ? AND state = 'active'").get(NS);
        for (const provider of PAYMENT_PROVIDERS) {
            for (const k of provider.keys.filter((x) => x.secret)) {
                assert.ok(!row.values_json.includes(SECRETS[provider.id][k.name.split('.').slice(1).join('.')]), `${k.name} is sealed at rest`);
            }
        }
        const stale = await t.call('POST', `/internal/config/${NS}`, {
            cap: CAP, headers: { 'x-ov-subject': owner.id },
            body: { values: { 'paypal.live': true }, merge: true, reason: 'stale' }, key: null,
        });
        assert.deepStrictEqual([stale.status, stale.json.code], [403, 'config.fresh_required'], 'the live switch needs a fresh sign-in');
    });

    await check('the test hook reads the provider and says so in one line, without spending', async () => {
        const r = await test('paypal.client_secret');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.json.ok, r.json.state, r.json.source], [true, 'connected', 'vault']);
        assert.match(r.json.message, /^PayPal accepted the key: 2 webhook\(s\) on the app/);
        assert.match(r.json.message, /Sandbox mode/);
        const c = await test('coinbase.api_key');
        assert.deepStrictEqual([c.json.ok, c.json.state], [true, 'connected']);
        assert.match(c.json.message, /^Coinbase Commerce accepted the key: 1 charge\(s\) on the store\. Nothing was charged\.$/);
        const s = await test('square.access_token');
        assert.match(s.json.message, /^Square accepted the key: 1 location\(s\) \(Main\)/);
        const p = await test('paddle.api_key');
        assert.match(p.json.message, /^Paddle accepted the key: 1 product\(s\) in the catalogue/);
        const l = await test('lemon_squeezy.api_key');
        assert.match(l.json.message, /^Lemon Squeezy accepted the key: 1 store\(s\) \(Store\)/);
        for (const r2 of [r, c, s, p, l]) {
            assert.ok(r2.json.message.length <= 200 && !r2.json.message.includes('\n'));
            for (const secret of Object.values(SECRETS).flatMap((o) => Object.values(o))) {
                assert.ok(!r2.text.includes(secret), 'the answer carries no key');
            }
        }
    });

    await check('a key the provider refuses is Not working in one line', async () => {
        const bad = await put('coinbase.api_key', key('BadCoinbaseApiKey'));
        assert.strictEqual(bad.status, 200);
        const r = await test('coinbase.api_key');
        assert.deepStrictEqual([r.json.ok, r.json.state], [false, 'not_working']);
        assert.match(r.json.message, /^Coinbase Commerce refused the key \(401\)/);
    });

    await check('the webhook verifies the provider\'s signature and records the event without moving money', async () => {
        const before = await t.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get();
        const money = await t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get();
        const body = JSON.stringify({ id: 'evt_1', type: 'charge:confirmed', data: { id: 'ch_1' } });
        const sig = crypto.createHmac('sha256', SECRETS.coinbase.webhook_secret).update(body).digest('hex');
        const res = await fetch(`${t.base}/checkout/webhooks/coinbase`, {
            method: 'POST', body,
            headers: { 'Content-Type': 'application/json', 'X-CC-Webhook-Signature': sig },
        });
        // The body is read once: the assertion message would otherwise consume it.
        const said = await res.text();
        assert.strictEqual(res.status, 200, said);
        const json = JSON.parse(said);
        assert.deepStrictEqual([json.received, json.recorded], [true, true]);
        const row = await t.db.prepare('SELECT provider, provider_event_id, processed_at, result FROM provider_events WHERE id = ?').get(json.event);
        assert.strictEqual(row.provider, 'coinbase');
        assert.strictEqual(row.provider_event_id, 'evt_1');
        assert.ok(row.processed_at, 'the event is recorded');
        assert.match(JSON.parse(row.result).reason, /checkout adapter comes later/);
        // Nothing moved: no transaction, and the journal is untouched.
        const after = await t.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get();
        assert.strictEqual(after.n, before.n + 1);
        assert.strictEqual((await t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).n, money.n);
        await t.assertReconciled('after a checkout webhook');
        // A wrong signature is refused and stores nothing.
        const bad = await fetch(`${t.base}/checkout/webhooks/coinbase`, {
            method: 'POST', body,
            headers: { 'Content-Type': 'application/json', 'X-CC-Webhook-Signature': 'not-the-signature' },
        });
        assert.strictEqual(bad.status, 401);
        assert.strictEqual((await t.db.prepare('SELECT COUNT(*) AS n FROM provider_events').get()).n, after.n);
    });

    await check('a provider with no webhook secret is not enabled, and its endpoint says so', async () => {
        // Square's signature key is set, so its endpoint is on and it refuses a notice it cannot check.
        const signed = await fetch(`${t.base}/checkout/webhooks/square`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
        assert.strictEqual(signed.status, 401);
        // Take the key away again: with no signing key the endpoint is not enabled and says so.
        const gone = await cfg('DELETE', `/internal/config/${NS}/secrets/square.signature_key`, { reason: 'setup' });
        assert.strictEqual(gone.status, 200, gone.text);
        const res = await fetch(`${t.base}/checkout/webhooks/square`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
        const said = await res.text();
        assert.strictEqual(res.status, 404, said);
        assert.strictEqual(JSON.parse(said).code, 'billing.provider_disabled');
    });

    await check('no log line, console line or answer carries a key', async () => {
        for (const k of Object.keys(original)) console[k] = original[k];
        for (const secret of Object.values(SECRETS).flatMap((o) => Object.values(o))) {
            assert.ok(t.logs.every((line) => !line.includes(secret)), 'a log line carries a key');
            assert.ok(consoleLines.every((line) => !line.includes(secret)), 'a console line carries a key');
        }
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
