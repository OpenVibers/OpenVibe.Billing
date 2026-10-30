'use strict';
/**
 * ADR-033: Billing's part of an account export and deletion (server/account-data.js), with a stand-in Network. The
 * export carries the person's balances and every money record about them, a creator's subscriptions without the
 * members' identities; a deletion keeps the money records (the ledger still reconciles) and removes settings (tier
 * prices, connected payment accounts), confirmed once with its counts. The route is loopback only and signed.
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { createNetworkSender, uncovered } = require('openvibe-sdk/account-data');
const { boot, fund, check, done } = require('./helpers/app');
const { TABLES } = require('../server/account-data');
const { testDb } = require('./helpers/db');

async function startNetworkStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_billing', token_type: 'Bearer', expires_in: 300 });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
            return json(201, {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from(crypto.randomBytes(26), (b) => CROCKFORD[b % 32]).join('');
const envelope = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), actor: { type: 'service', id: 'network' }, subject: { type: 'account', id: payload.subject }, visibility: 'internal', payload });

(async () => {
    await check('every table that names a person is covered or exempted with a reason', async () => {
        const d = await testDb();
        try {
            const missing = await uncovered(d, {
                tables: TABLES,
                               exempt: {"account_data_events":"the ledger of requests itself: which export and deletion Billing applied"},
            });
            assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
        } finally { await d.close(); }
    });

    const stub = await startNetworkStub();
    const secret = crypto.randomBytes(32).toString('hex');
    const t = await boot({ env: { BILLING_EVENTS_SECRET: secret, BILLING_RENEWAL_GRACE_DAYS: '0' }, accountSend: createNetworkSender({ networkInternalUrl: stub.url, clientId: 'billing', clientSecret: 'shh' }) });
    const fan = t.user(61);
    const creator = t.user(62);
    const accountData = t.app.locals.accountData;
    const send = t.app.locals.accountSend;
    const files = (part) => Object.fromEntries(part.body.files.map((f) => [f.name, f.content]));

    await check('a fan and a creator make money records through the API', async () => {
        await fund(t, fan, 2000);
        const tip = await t.call('POST', '/api/v1/transfers', { cap: ['billing.transfer.create'], body: { from: fan, to: creator, amount: 300, kind: 'donation', message: 'gg' } });
        assert.strictEqual(tip.status, 201, tip.text);
        const put = await t.call('PUT', `/api/v1/tiers/${creator.id}/1`, { cap: ['billing.tier.manage'], body: { price_cents: 300 }, headers: { 'Idempotency-Key': `tier-${crypto.randomUUID()}` } });
        assert.strictEqual(put.status, 200, put.text);
        const sub = await t.call('POST', '/api/v1/subscriptions', { cap: ['billing.subscription.manage'], body: { subscriber: fan, streamer: creator, source: 'credit' } });
        assert.strictEqual(sub.status, 201, sub.text);
    });

    await check("the fan's export: balances, what they sent, their subscription and entitlement", async () => {
        const out = await accountData.apply(envelope(`evt_${ulid()}`, 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX1', subject: fan.id }), { send });
        assert.strictEqual(out, 'exported');
        const part = stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX1/parts');
        assert.strictEqual(part.auth, 'Bearer tok_billing');
        const f = files(part);
        assert.ok(f['balances.json'].some((b) => b.kind === 'user_credit' && Number(b.balance) === 2000 - 300 - 300), JSON.stringify(f['balances.json']));
        assert.deepStrictEqual(f['transactions-sent.json'].map((x) => x.type).sort(), ['donation', 'subscription']);
        assert.strictEqual(f['subscriptions.json'].length, 1);
        assert.strictEqual(f['entitlements.json'].length, 1);
    });

    await check("the creator's export: what they received and their subscriptions, without who the members are", async () => {
        await accountData.apply(envelope(`evt_${ulid()}`, 'network.account.export_requested', { export_id: 'exp_01JZ0000000000000000000EX2', subject: creator.id }), { send });
        const f = files(stub.calls.find((c) => c.url === '/internal/account-exports/exp_01JZ0000000000000000000EX2/parts'));
        assert.ok(f['transactions-received.json'].length >= 2);
        assert.strictEqual(f['subscriptions-to-you.json'].length, 1);
        assert.ok(!('subscriber' in f['subscriptions-to-you.json'][0]), "the member's identity is not the creator's data");
        assert.deepStrictEqual(f['tier-prices.json'].map((x) => [x.tier, Number(x.price_cents)]), [[1, 300]]);
    });

    await check('a deletion keeps the money records, removes tier prices, and is confirmed once', async () => {
        const before = Number(await t.db.value('SELECT COUNT(*)::int FROM transactions'));
        const del = envelope(`evt_${ulid()}`, 'network.account.deleted', { deletion_id: 'del_01JZ0000000000000000000DE1', subject: creator.id, requested_at: new Date(Date.now() - 30 * 86400000).toISOString(), deleted_at: new Date().toISOString() });
        assert.strictEqual(await accountData.apply(del, { send }), 'erased');
        assert.strictEqual(Number(await t.db.value('SELECT COUNT(*)::int FROM transactions')), before, 'the ledger stays whole');
        assert.strictEqual(Number(await t.db.value('SELECT COUNT(*)::int FROM subscription_tiers WHERE streamer = $1', [creator.id])), 0);
        const conf = stub.calls.filter((c) => c.url === '/internal/account-deletions/del_01JZ0000000000000000000DE1/confirmations');
        assert.strictEqual(conf.length, 1);
        assert.ok(conf[0].body.retained.transactions_received >= 2, JSON.stringify(conf[0].body));
        assert.ok(conf[0].body.retained.accounts >= 1);
        assert.notStrictEqual(await accountData.apply(del, { send }), 'erased', 'a redelivery never erases twice');
        await t.assertReconciled('after a deletion');
    });

    await check('the route is loopback only and signed', async () => {
        const unsigned = await fetch(`${t.base}/internal/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.strictEqual(unsigned.status, 401);
        const proxied = await fetch(`${t.base}/internal/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9' }, body: '{}' });
        assert.strictEqual(proxied.status, 403);
    });

    await t.close();
    await stub.close();
    done();
})();
