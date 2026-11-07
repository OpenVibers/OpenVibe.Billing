'use strict';
/**
 * Owner inputs (the owner-setup design of 2026-11-07): the card processor's keys and live switch in `billing.cards`,
 * listed by the admin panel's Setup tab under Money.
 *
 * Proves: the new fields carry x-owner-input, titles and 30+ character descriptions, and every field of every Billing
 * namespace does; the Stripe adapter uses the panel's sealed value when it is set and STRIPE_* from the environment
 * otherwise, at use time; the live switch leaves a key of the other mode unused; the test hook answers in one line
 * and never carries the key, not even when Stripe echoes it; no log line or console line carries a key.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const { lintSchema } = require('./helpers/lint-schema');

const CAP = ['billing.config.manage'];
const KEK = 'k1:' + crypto.randomBytes(32).toString('base64');
// Made-up keys, built at run time so a secret scanner never reads a Stripe-shaped string in the source.
const stripeKey = (mode, rest) => ['sk', mode, rest].join('_');
const PANEL_KEY = stripeKey('test', 'madeUpPanelKeyNEVERSHOWN93ab');
const LIVE_KEY = stripeKey('live', 'madeUpLiveKeyNEVERSHOWN11d0');
const BAD_KEY = stripeKey('test', 'madeUpBadKeySTRIPEECHOESIT5e2f');
const WEBHOOK = 'whsec_madeUpSigningSecretNEVERSHOWN77';
const SECRETS = [PANEL_KEY, LIVE_KEY, BAD_KEY, WEBHOOK];

(async () => {
    console.log('owner inputs (billing.cards)');
    const consoleLines = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(original)) console[k] = (...a) => { consoleLines.push(a.join(' ')); original[k](...a); };
    const t = await boot({ stripe: true, env: { OV_CONFIG_KEKS: KEK, OV_CONFIG_KEK_CURRENT: 'k1' } });
    t.stripe.state.goodKeys = ['sk_test_x', PANEL_KEY, LIVE_KEY];
    const owner = t.user(501);
    const headers = { 'x-ov-subject': owner.id, 'x-ov-fresh': '1' };
    const cfg = (method, path, body) => t.call(method, path, { cap: CAP, headers, body, key: null });
    const put = (key, value) => cfg('PUT', `/internal/config/billing.cards/secrets/${key}`, { value, reason: 'setup' });
    const test = (key) => cfg('POST', `/internal/config/billing.cards/test/${key}`);
    const stripe = () => t.ctx.config.providers.stripe;

    await check('every field of every Billing namespace has a title, a 30+ character description and labelled options', async () => {
        const r = await cfg('GET', '/internal/config');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.namespaces.map((n) => n.namespace), ['billing.credits', 'billing.vibes', 'billing.cards']);
        for (const ns of r.json.namespaces) assert.deepStrictEqual(lintSchema(ns.schema), [], `${ns.namespace}: ${lintSchema(ns.schema).join('; ')}`);
    });

    await check('the card processor is four owner inputs in the Money group; the keys are required for card payments', async () => {
        const r = await cfg('GET', '/internal/config/billing.cards');
        const p = r.json.schema.properties;
        for (const k of ['stripe.secret_key', 'stripe.publishable_key', 'stripe.webhook_secret', 'stripe.live']) {
            assert.strictEqual(p[k]['x-owner-input'].group, 'money', k);
            assert.match(p[k]['x-owner-input'].get_it_at, /^https:\/\/dashboard\.stripe\.com\//, k);
        }
        assert.deepStrictEqual([p['stripe.secret_key']['x-required-for'], p['stripe.secret_key']['x-owner-input'].test], ['Card payments', true]);
        assert.deepStrictEqual([p['stripe.webhook_secret']['x-required-for'], p['stripe.webhook_secret']['x-owner-input'].test], ['Card payments', true]);
        assert.strictEqual(p['stripe.publishable_key']['x-required-for'], undefined, 'optional: today\'s checkout does not need it');
        assert.strictEqual(p['stripe.live']['x-danger'], true);
        assert.deepStrictEqual(r.json.classification, {}, 'nothing stored yet');
        assert.strictEqual(r.json.sealed, true);
    });

    await check('without a panel value the environment\'s key is used, and the test says so', async () => {
        assert.strictEqual(stripe().secretKey, 'sk_test_x');
        const h = await t.call('GET', '/api/health', { token: null });
        assert.strictEqual(h.json.providers.stripe, true);
        const r = await test('stripe.secret_key');
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.json.ok, r.json.state, r.json.source], [true, 'connected', 'env']);
        assert.strictEqual(r.json.message, "Stripe accepted the key: account acct_TEST1 (OpenVibe test), test mode, no real card is charged. (the value from the server's settings file, STRIPE_SECRET_KEY)");
    });

    await check('a key entered in the panel is sealed, write-only and wins at use time', async () => {
        const r = await put('stripe.secret_key', PANEL_KEY);
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(!r.text.includes(PANEL_KEY));
        assert.strictEqual(stripe().secretKey, PANEL_KEY);
        const row = await t.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = 'billing.cards' AND state = 'active'").get();
        assert.ok(!row.values_json.includes(PANEL_KEY), 'sealed at rest');
        const carried = await cfg('POST', '/internal/config/billing.cards', { values: { 'stripe.secret_key': PANEL_KEY }, reason: 'not here' });
        assert.deepStrictEqual([carried.status, carried.json.code], [422, 'config.secret_write_only']);
        const before = t.stripe.calls.length;
        const intent = await t.call('POST', '/api/v1/intents', { body: { provider: 'stripe', kind: 'purchase', subject: t.user(502), bits: 1000, amount_cents: 1 } });
        assert.strictEqual(intent.status, 201, intent.text);
        assert.strictEqual(t.stripe.calls.slice(before).find((c) => c.url === '/checkout/sessions').auth, `Bearer ${PANEL_KEY}`, 'the checkout used the panel key');
        const tested = await test('stripe.secret_key');
        assert.deepStrictEqual([tested.json.ok, tested.json.source], [true, 'vault']);
        const summary = await cfg('GET', '/internal/config/billing.cards');
        assert.ok(!summary.text.includes(PANEL_KEY));
        assert.strictEqual(summary.json.secrets['stripe.secret_key'].hint, PANEL_KEY.slice(-4));
    });

    await check('a refused key is Not working in one line, and the echoed key never comes back', async () => {
        await put('stripe.secret_key', BAD_KEY);
        const r = await test('stripe.secret_key');
        assert.deepStrictEqual([r.json.ok, r.json.state], [false, 'not_working']);
        assert.match(r.json.message, /^Stripe refused the key \(401\): Invalid API Key provided: \[hidden\]/);
        assert.ok(!r.text.includes(BAD_KEY) && !r.text.includes(BAD_KEY.slice(0, 12)));
        assert.ok(r.json.message.length <= 200 && !r.json.message.includes('\n'));
    });

    await check('the live switch leaves a key of the other mode unused, and says why', async () => {
        await put('stripe.secret_key', LIVE_KEY);
        const off = await cfg('POST', '/internal/config/billing.cards', { values: { 'stripe.live': false }, merge: true, reason: 'test mode only' });
        assert.strictEqual(off.status, 200, off.text);
        assert.strictEqual(t.ctx.config.providers.stripe.modeProblem, 'the live switch is off but the secret key is a live key');
        assert.strictEqual((await t.call('GET', '/api/health', { token: null })).json.providers.stripe, false, 'no real card is charged while the switch is off');
        const r = await test('stripe.secret_key');
        assert.deepStrictEqual([r.json.ok, r.json.state], [false, 'not_working']);
        assert.match(r.json.message, /live switch is off and this is a live key, so card payments stay off/);
        const stale = await t.call('POST', '/internal/config/billing.cards', { cap: CAP, headers: { 'x-ov-subject': owner.id }, body: { values: { 'stripe.live': true }, merge: true, reason: 'stale' }, key: null });
        assert.deepStrictEqual([stale.status, stale.json.code], [403, 'config.fresh_required'], 'the live switch needs a fresh sign-in');
        const on = await cfg('POST', '/internal/config/billing.cards', { values: { 'stripe.live': true }, merge: true, reason: 'go live' });
        assert.strictEqual(on.status, 200, on.text);
        assert.strictEqual((await t.call('GET', '/api/health', { token: null })).json.providers.stripe, true);
    });

    await check('the webhook signing secret: the panel value verifies deliveries; the test checks Stripe sends to Billing', async () => {
        await put('stripe.secret_key', 'sk_test_x');
        await cfg('POST', '/internal/config/billing.cards', { values: {}, unset: ['stripe.live'], merge: true, reason: 'back to unset' });
        await put('stripe.webhook_secret', WEBHOOK);
        assert.strictEqual(stripe().webhookSecret, WEBHOOK);
        const oldSecret = await t.stripeEvent({ id: 'evt_old', type: 'ping', data: { object: {} } });
        assert.strictEqual(oldSecret.status, 401, 'the environment\'s secret no longer verifies once the panel has one');
        const newSecret = await t.stripeEvent({ id: 'evt_new', type: 'ping', data: { object: {} } }, { secret: WEBHOOK });
        assert.notStrictEqual(newSecret.status, 401);
        const r = await test('stripe.webhook_secret');
        assert.deepStrictEqual([r.json.ok, r.json.state, r.json.source], [true, 'connected', 'vault']);
        assert.match(r.json.message, /^Stripe sends payment notices to https:\/\/billing\.openvibe\.network\/webhooks\/stripe/);
        t.stripe.state.endpoints = [];
        const none = await test('stripe.webhook_secret');
        assert.deepStrictEqual([none.json.ok, none.json.state], [false, 'not_working']);
        assert.ok(!none.text.includes(WEBHOOK));
    });

    await check('removing the panel values falls back to the environment', async () => {
        const del = await cfg('DELETE', '/internal/config/billing.cards/secrets/stripe.webhook_secret', { reason: 'back to env' });
        assert.strictEqual(del.status, 200, del.text);
        assert.strictEqual(stripe().webhookSecret, 'whsec_x');
        const del2 = await cfg('DELETE', '/internal/config/billing.cards/secrets/stripe.secret_key', { reason: 'back to env' });
        assert.strictEqual(del2.status, 200, del2.text);
        assert.strictEqual(stripe().secretKey, 'sk_test_x');
    });

    await check('the test hook is guarded and answers only for keys with a test', async () => {
        const denied = await t.call('POST', '/internal/config/billing.cards/test/stripe.secret_key', { cap: ['billing.balance.read'], headers, key: null });
        assert.strictEqual(denied.status, 403, denied.text);
        const none = await test('stripe.live');
        assert.deepStrictEqual([none.status, none.json.code], [404, 'config.test_not_found']);
        const pub = await test('stripe.publishable_key');
        assert.strictEqual(pub.status, 404);
        const notSet = await cfg('POST', '/internal/config/billing.vibes/test/vibes_pay');
        assert.strictEqual(notSet.status, 404);
    });

    await check('no log line, console line or audit row carries a key', async () => {
        for (const k of Object.keys(original)) console[k] = original[k];
        const audit = JSON.stringify(await t.db.prepare('SELECT * FROM staff_audit').all());
        for (const s of SECRETS) {
            assert.ok(t.logs.every((line) => !line.includes(s)), `a log line carries ${s.slice(0, 14)}…`);
            assert.ok(consoleLines.every((line) => !line.includes(s)), `a console line carries ${s.slice(0, 14)}…`);
            assert.ok(!audit.includes(s), 'the audit carries a key');
        }
        assert.ok(t.logs.some((line) => /\[config\] test billing\.cards stripe\.secret_key: not working/.test(line)), 'the outcome is logged without the key');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
