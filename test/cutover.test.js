'use strict';
/**
 * Cutover guards (docs/live-cutover.md): a Live payment order that Live already credited must
 * never be credited again by Billing when its PowerChat delivery reaches Billing after the webhook
 * is re-pointed (a PowerChat retry of a delivery Live acknowledged, or a manual resend). The import
 * marks such intents settled-in-Live — also when Live credited the order AFTER an earlier shadow
 * import — and settlement refuses them (rejected, listed by reconciliation for review). A legacy
 * order Live never credited still settles exactly once (a checkout that was in flight), and a later
 * import run never books an opening-balance adjustment against what Billing settled itself.
 */
const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');
const { boot, check, done } = require('./helpers/app');

function fabricateLive(file) {
    const live = new Database(file);
    const recent = new Date(Date.now() - 30 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    live.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, openvibe_bucks_balance REAL DEFAULT 0.00,
            openvibe_bucks_cashout_balance REAL DEFAULT 0.00);
        CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user_id INTEGER, to_user_id INTEGER, stream_id INTEGER,
            amount INTEGER NOT NULL, type TEXT NOT NULL, status TEXT DEFAULT 'completed', message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE payment_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL, provider_ref TEXT,
            kind TEXT NOT NULL DEFAULT 'bucks', amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT DEFAULT 'usd', bucks INTEGER DEFAULT 0,
            streamer_id INTEGER, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, subscriber_id INTEGER NOT NULL, streamer_id INTEGER NOT NULL, tier INTEGER DEFAULT 1,
            provider TEXT, provider_ref TEXT, price_cents INTEGER DEFAULT 0, status TEXT DEFAULT 'active', auto_renew INTEGER DEFAULT 0,
            current_period_end DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO users (id, username, openvibe_bucks_balance, openvibe_bucks_cashout_balance) VALUES (1, 'alice', 500, 0), (2, 'bob', 0, 349), (3, 'carol', 0, 0);
        INSERT INTO transactions (id, from_user_id, to_user_id, amount, type, status, created_at) VALUES (1, NULL, 1, 500, 'purchase', 'completed', '${recent}');
    `);
    live.prepare(`INSERT INTO payment_orders (id, user_id, provider, provider_ref, kind, amount_cents, bucks, streamer_id, status, created_at) VALUES
        (1, 1, 'powerchat', NULL, 'bucks', 700, 500, NULL, 'credited', ?),
        (2, 3, 'powerchat', NULL, 'bucks', 700, 500, NULL, 'pending', ?),
        (3, 1, 'powerchat', 'site:fee=50', 'subscription', 549, 0, 2, 'credited', ?),
        (4, 3, 'powerchat', NULL, 'bucks', 1300, 1000, NULL, 'pending', ?)`).run(recent, recent, recent, recent);
    const end = new Date(Date.now() + 20 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    live.prepare(`INSERT INTO subscriptions (id, subscriber_id, streamer_id, provider, price_cents, status, current_period_end, created_at)
        VALUES (1, 1, 2, 'powerchat', 549, 'active', ?, ?)`).run(end, recent);
    live.close();
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser(1);
    const bob = t.network.addUser(2);
    const carol = t.network.addUser(3);
    const file = path.join(t.dir, 'live-snapshot.db');
    fabricateLive(file);
    const { importLive } = require('../server/importer/live');
    const { createIdentity } = require('../server/network');
    const identity = createIdentity(t.config);
    const run = async () => {
        const live = new Database(file, { readonly: true, fileMustExist: true });
        try { return await importLive(t.ctx, { live, resolveLiveUsers: identity.resolveLiveUsers, log: { log() {} } }); } finally { live.close(); }
    };
    const bal = (kind, owner) => { const { balance } = require('../server/ledger'); return balance(t.db, { kind, owner, currency: 'vibes-bits' }); };
    const intent = (order) => t.db.prepare('SELECT * FROM payment_intents WHERE legacy_order_id = ?').get(order);
    let n = 0;
    const tip = (ref, cents) => t.powerchat({ type: 'donation.completed', streamer: { username: 'openvibe' }, data: { eventId: `ev_cutover_${++n}`, appExternalRef: ref, amountUsdCents: cents } });
    const result = (r) => t.db.prepare('SELECT result FROM provider_events WHERE id = ?').get(r.json.event).result;
    console.log('cutover guards');

    await run();

    await check('an order Live credited is imported as settled-in-Live', async () => {
        assert.strictEqual(intent(1).status, 'settled');
        assert.strictEqual(intent(1).settled_txn, null);
        assert.strictEqual(bal('user_credit', alice), 500);
    });

    await check('its PowerChat delivery reaching Billing is refused (rejected, for review), never credited twice', async () => {
        const r = await tip('pcorder:1', 700);
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const res = JSON.parse(result(r));
        assert.strictEqual(res.effect, 'rejected');
        assert.strictEqual(res.code, 'billing.intent_settled_in_live');
        assert.strictEqual(bal('user_credit', alice), 500);
        const rec = t.assertReconciled('after a refused legacy delivery');
        assert.ok(rec.warnings.rejected_events.some((e) => e.id === r.json.event), 'listed for review');
    });

    await check('a subscription order Live credited is not paid (or granted) again either', async () => {
        const ents = t.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n;
        const r = await tip('pcsub:3', 549);
        assert.strictEqual(JSON.parse(result(r)).code, 'billing.intent_settled_in_live');
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM entitlements').get().n, ents);
        assert.strictEqual(bal('creator_payable', bob), 349);
    });

    await check('an order Live credited AFTER the shadow import is settled-in-Live after the final import', async () => {
        assert.strictEqual(intent(4).status, 'created');
        const live = new Database(file);
        live.exec(`UPDATE payment_orders SET status = 'credited' WHERE id = 4;
            UPDATE users SET openvibe_bucks_balance = 1000 WHERE id = 3;
            INSERT INTO transactions (from_user_id, to_user_id, amount, type, status) VALUES (NULL, 3, 1000, 'purchase', 'completed');`);
        live.close();
        const report = await run();
        assert.ok(report.counts.intents_updated >= 1, JSON.stringify(report.counts));
        assert.strictEqual(intent(4).status, 'settled');
        assert.strictEqual(bal('user_credit', carol), 1000);
        const r = await tip('pcorder:4', 1300);
        assert.strictEqual(JSON.parse(result(r)).code, 'billing.intent_settled_in_live');
        assert.strictEqual(bal('user_credit', carol), 1000);
    });

    await check('a legacy order Live never credited (a checkout in flight) settles exactly once', async () => {
        const r = await tip('pcorder:2', 700);
        assert.strictEqual(JSON.parse(result(r)).effect, 'settled');
        assert.strictEqual(bal('user_credit', carol), 1500);
        assert.strictEqual(intent(2).status, 'settled');
        const again = await t.powerchat({ type: 'donation.completed', streamer: { username: 'openvibe' }, data: { eventId: `ev_cutover_${n}`, appExternalRef: 'pcorder:2', amountUsdCents: 700 } });
        assert.strictEqual(JSON.parse(result(again)).effect, 'duplicate_receipt');
        assert.strictEqual(bal('user_credit', carol), 1500);
        const report = await run();
        assert.strictEqual(intent(2).status, 'settled', 'a re-import never rewinds what Billing settled');
        assert.strictEqual(report.new_transactions, 0);
        assert.deepStrictEqual(report.adjustments, [], 'no adjustment against a Billing-native settlement');
        assert.strictEqual(bal('user_credit', carol), 1500);
        t.assertReconciled('after the final import');
    });

    await check('the host freeze CLI holds webhooks and refuses writes; after "off" the held delivery settles once', async () => {
        const { spawnSync } = require('child_process');
        const cli = (...args) => {
            const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'freeze.js'), ...args], { env: { ...process.env, BILLING_DB_PATH: t.config.dbPath }, encoding: 'utf8' });
            assert.strictEqual(r.status, 0, r.stderr);
            return JSON.parse(r.stdout);
        };
        assert.strictEqual(cli('on', 'Live cutover').frozen, true);
        const w = await t.call('POST', '/api/v1/transfers', { body: { from: { type: 'user', id: carol }, to: { type: 'user', id: bob }, amount: 5 } });
        assert.strictEqual(w.status, 503); assert.strictEqual(w.json.code, 'billing.frozen');
        const live = new Database(file);
        live.exec("INSERT INTO payment_orders (id, user_id, provider, kind, amount_cents, bucks, status) VALUES (5, 3, 'powerchat', 'bucks', 700, 500, 'pending')");
        live.close();
        await run();                                   // the final import, while Billing is frozen
        const held = await tip('pcorder:5', 700);
        assert.strictEqual(held.status, 202, JSON.stringify(held.json));
        assert.strictEqual(cli('status').held_webhooks, 1);
        assert.strictEqual(cli('off').frozen, false);
        await require('../server/providers').processPending(t.ctx, t.app.locals.adapters);   // the service's retry tick
        assert.strictEqual(JSON.parse(result(held)).effect, 'settled');
        assert.strictEqual(bal('user_credit', carol), 2000);
        t.assertReconciled('after the freeze window');
    });

    await t.close();
    done();
})();
