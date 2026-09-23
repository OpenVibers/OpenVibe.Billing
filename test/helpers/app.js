'use strict';
/**
 * Boots Billing against the stubs on a random port with a temp database, and returns a small
 * client: call() signs a service token with the capabilities asked for and adds an
 * Idempotency-Key to every POST unless told otherwise.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { startNetwork, startStripe } = require('./stubs');

async function boot(opts = {}) {
    const network = opts.network || await startNetwork();
    const stripe = opts.stripe ? await startStripe() : null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-test-'));
    const env = {
        NODE_ENV: 'test',
        BILLING_DB_PATH: path.join(dir, 'billing.db'),
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.url,
        OV_OAUTH_CLIENT_ID: 'billing',
        OV_OAUTH_CLIENT_SECRET: 'shh',
        POWERCHAT_WEBHOOK_SECRET: 'pc-secret',
        POWERCHAT_SITE_USERNAME: 'openvibe',
        ...(stripe ? { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', STRIPE_API_BASE: stripe.url } : {}),
        ...(opts.env || {}),
    };
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
    const { loadConfig } = require('../../server/config');
    const { createApp } = require('../../server/app');
    const config = loadConfig(env);
    const clock = { offset: 0 };
    const logs = [];
    const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
    const app = createApp({ config, now: () => Date.now() + clock.offset, log });
    await app.locals.keys.load();
    const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const ctx = app.locals.ctx;

    let n = 0;
    async function call(method, p, { body, cap = ['billing.*'], key, token, headers = {}, sub = 'svc:live' } = {}) {
        const h = { ...headers };
        if (token !== null) h.Authorization = `Bearer ${token || network.signService({ sub, cap })}`;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        if (method === 'POST' && key !== null) h['Idempotency-Key'] = key || `test-key-${process.pid}-${++n}-${crypto.randomBytes(4).toString('hex')}`;
        const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: res.status, headers: res.headers, json, text };
    }

    /** POST a signed PowerChat delivery. */
    async function powerchat(envelope, { deliveryId = crypto.randomUUID(), secret = 'pc-secret', ts = Date.now() } = {}) {
        const raw = JSON.stringify(envelope);
        const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
        const res = await fetch(`${base}/webhooks/powerchat`, {
            method: 'POST', body: raw,
            headers: { 'Content-Type': 'application/json', 'X-PowerChat-Signature': sig, 'X-PowerChat-Timestamp': String(ts), 'X-PowerChat-Delivery-Id': deliveryId, 'X-PowerChat-Event-Type': envelope.type },
        });
        return { status: res.status, json: await res.json().catch(() => null) };
    }

    /** POST a signed Stripe event. */
    async function stripeEvent(event, { secret = 'whsec_x' } = {}) {
        const raw = JSON.stringify(event);
        const t = Math.floor(Date.now() / 1000);
        const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
        const res = await fetch(`${base}/webhooks/stripe`, { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${sig}` } });
        return { status: res.status, json: await res.json().catch(() => null) };
    }

    /** Reconciliation must pass (journal balanced, caches right, events settled once). */
    function assertReconciled(label = '') {
        const { reconcile } = require('../../server/reconcile');
        const r = reconcile(ctx, { store: false });
        const failed = r.checks.filter((c) => !c.ok);
        assert.deepStrictEqual(failed, [], `reconciliation failed ${label}: ${JSON.stringify(failed)}`);
        return r;
    }

    async function balances(subject) {
        const r = await call('GET', `/api/v1/balances/${subject}`, { cap: ['billing.balance.read'] });
        assert.strictEqual(r.status, 200, r.text);
        return r.json;
    }

    const user = (liveId) => ({ type: 'user', id: network.addUser(liveId) });

    return {
        app, base, call, ctx, db: ctx.db, config, clock, network, stripe, powerchat, stripeEvent, assertReconciled, balances, user, logs, dir,
        close: async () => {
            await new Promise((r) => server.close(r));
            if (!opts.network) await network.close();
            if (stripe) await stripe.close();
            try { ctx.db.close(); } catch { /* */ }
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/**
 * Give `subject` spendable credit the way production does: a settled provider receipt
 * (operator-grade settle endpoint), so every test balance has a real journal origin.
 */
async function fund(t, subject, bits, provider = 'powerchat') {
    const r = await t.call('POST', '/api/v1/purchases/settle', {
        body: { provider, provider_ref: `fund-${crypto.randomBytes(6).toString('hex')}`, subject, amount_cents: t.ctx.rates.valueCents(bits), bits },
    });
    assert.strictEqual(r.status, 201, r.text);
    return r.json.transaction;
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 6).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, fund, check, done };
