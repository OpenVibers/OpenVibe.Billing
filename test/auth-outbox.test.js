'use strict';
/**
 * Service-token authentication and capability grants; the transactional outbox and its relay to
 * OpenVibe.Events; the reconciliation endpoint catching a corrupted cached balance.
 */
const assert = require('assert');
const { validate, serviceAuth } = require('openvibe-contracts');
const { boot, fund, check, done } = require('./helpers/app');
const { startEvents } = require('./helpers/stubs');

(async () => {
    const t = await boot();
    const a = t.user(51);
    const b = t.user(52);
    console.log('auth, outbox, reconciliation');

    await check('no token, wrong audience, wrong issuer and expired tokens are refused', async () => {
        const none = await t.call('GET', `/api/v1/balances/${a.id}`, { token: null });
        assert.strictEqual(none.status, 401);
        const aud = await t.call('GET', `/api/v1/balances/${a.id}`, { token: t.network.signService({ aud: ['openvibe.media'], cap: ['billing.*'] }) });
        assert.strictEqual(aud.json.code, 'token.wrong_audience');
        const iss = await t.call('GET', `/api/v1/balances/${a.id}`, { token: t.network.signService({ iss: 'https://evil.example', cap: ['billing.*'] }) });
        assert.strictEqual(iss.json.code, 'token.wrong_issuer');
        const exp = await t.call('GET', `/api/v1/balances/${a.id}`, { token: t.network.signService({ cap: ['billing.*'], expSec: -120 }) });
        assert.strictEqual(exp.json.code, 'token.expired');
    });

    await check('capabilities: exact ids and .* families are honoured, nothing else', async () => {
        assert.strictEqual((await t.call('GET', `/api/v1/balances/${a.id}`, { cap: ['billing.balance.read'] })).status, 200);
        assert.strictEqual((await t.call('GET', `/api/v1/balances/${a.id}`, { cap: ['billing.balance.*'] })).status, 200);
        const denied = await t.call('GET', `/api/v1/balances/${a.id}`, { cap: ['billing.entitlement.check', 'network.coins.credit'] });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.json.code, 'capability.denied');
        assert.strictEqual((await t.call('GET', '/api/v1/admin/freeze', { cap: ['billing.cashout.manage'] })).status, 403);
        assert.strictEqual((await t.call('GET', '/api/v1/admin/freeze', { cap: ['billing.ledger.admin'] })).status, 200);
        const bad = await t.call('GET', '/api/v1/balances/42', { cap: ['billing.balance.read'] });
        assert.strictEqual(bad.json.code, 'billing.invalid_subject');
    });

    await check('every settled operation writes a valid event envelope in the same transaction', async () => {
        await fund(t, a, 1500);
        assert.strictEqual((await t.call('POST', '/api/v1/transfers', { body: { from: a, to: b, amount: 600 } })).status, 201);
        await t.call('POST', '/api/v1/cashouts', { body: { subject: b, amount: 500, payout_method: { type: 'paypal', address: 'b@example.com' } } });
        assert.strictEqual((await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: a, streamer: b, source: 'credit', auto_renew: false } })).status, 201);
        const rows = t.db.prepare('SELECT event FROM outbox ORDER BY seq').all().map((r) => JSON.parse(r.event));
        const types = rows.map((e) => e.event_type);
        for (const type of ['billing.transaction.settled', 'billing.cashout.requested', 'billing.entitlement.changed']) assert.ok(types.includes(type), `${type} in ${types}`);
        for (const e of rows) {
            const v = validate('events.event-envelope@1', e);
            assert.ok(v.valid, JSON.stringify(v.errors));
            assert.deepStrictEqual([e.source, e.actor.type, e.actor.id], ['billing', 'service', 'billing']);
            assert.ok(['transaction', 'entitlement', 'cashout', 'subscription'].includes(e.subject.type));
        }
        const txnCount = t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
        const refused = await t.call('POST', '/api/v1/transfers', { body: { from: a, to: b, amount: 999999 } });
        assert.strictEqual(refused.status, 409);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, rows.length, 'a refused operation writes no event');
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, txnCount);
    });

    await check('the relay publishes unsent events to OpenVibe.Events with an events.event.publish token', async () => {
        const events = await startEvents();
        const { createRelay } = require('../server/outbox');
        const relay = createRelay({ db: t.db, config: { ...t.config, events: { url: events.url, intervalMs: 1000 } }, log: { warn() {} } });
        const n = t.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get().n;
        const r = await relay.flush();
        assert.strictEqual(r.sent, n);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get().n, 0);
        const token = events.tokens[0].slice(7);
        const v = serviceAuth.verifyServiceToken(token, { publicKey: t.network.publicPem, audience: 'openvibe.events' });
        assert.ok(v.ok, v.reason);
        assert.deepStrictEqual(v.claims.cap, ['events.event.publish']);
        assert.strictEqual(v.claims.sub, 'svc:billing');
        assert.strictEqual((await relay.flush()).sent, 0);
        await events.close();
    });

    await check('GET /admin/reconcile stores a run and detects a deliberately corrupted cached balance', async () => {
        const ok = await t.call('GET', '/api/v1/admin/reconcile', { cap: ['billing.ledger.admin'] });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(ok.json.ok, true, JSON.stringify(ok.json.checks.filter((c) => !c.ok)));
        assert.strictEqual(ok.json.totals.excludes_test_transactions, true);
        t.db.prepare("UPDATE account_balances SET balance = balance - 7 WHERE account_id = (SELECT id FROM accounts WHERE kind = 'creator_payable' AND owner_subject = ?)").run(b.id);
        const bad = await t.call('GET', '/api/v1/admin/reconcile', { cap: ['billing.ledger.admin'] });
        assert.strictEqual(bad.json.ok, false);
        const c = bad.json.checks.find((x) => x.id === 'balances.cache');
        assert.strictEqual(c.detail.mismatches[0].owner, b.id);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_runs').get().n, 2);
    });

    await t.close();
    done();
})();
