'use strict';
/**
 * Import from a fabricated live.db snapshot (Live's own table shapes): opening balances equal the
 * Live columns, differences against the replayed history are adjustments and listed, unmapped users
 * are held (never dropped) and released once mapped, test-era rows are flagged, duplicate provider
 * refs and route markers are handled, dry runs keep nothing, and a re-run changes nothing.
 */
const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');
const { boot, check, done } = require('./helpers/app');

function fabricateLive(file) {
    const live = new Database(file);
    live.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, openvibe_bucks_balance REAL DEFAULT 0.00,
            openvibe_coins_balance INTEGER DEFAULT 0, openvibe_bucks_cashout_balance REAL DEFAULT 0.00);
        CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, from_user_id INTEGER, to_user_id INTEGER, stream_id INTEGER,
            amount INTEGER NOT NULL, type TEXT NOT NULL CHECK(type IN ('donation', 'purchase', 'subscription', 'cashout', 'refund', 'bonus')),
            status TEXT DEFAULT 'completed' CHECK(status IN ('pending', 'completed', 'failed', 'escrow', 'refunded')), message TEXT,
            paypal_transaction_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE payment_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, provider TEXT NOT NULL, provider_ref TEXT,
            kind TEXT NOT NULL DEFAULT 'bucks', amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT DEFAULT 'usd', bucks INTEGER DEFAULT 0,
            streamer_id INTEGER, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, subscriber_id INTEGER NOT NULL, streamer_id INTEGER NOT NULL, tier INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1, started_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME, provider TEXT, provider_ref TEXT,
            price_cents INTEGER DEFAULT 0, currency TEXT DEFAULT 'usd', status TEXT DEFAULT 'active', cancel_at_period_end INTEGER DEFAULT 0,
            auto_renew INTEGER DEFAULT 0, current_period_end DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '', type TEXT DEFAULT 'string', updated_at DATETIME);
        INSERT INTO site_settings (key, value) VALUES ('stats_vibes_reset_at', '2026-06-01T00:00:00Z');
        INSERT INTO users (id, username, openvibe_bucks_balance, openvibe_bucks_cashout_balance, openvibe_coins_balance) VALUES
            (1, 'alice', 1500, 0, 999), (2, 'bob', 0, 700, 0), (3, 'carol', 250, 0, 0), (4, 'dave', 100.5, 0, 0), (5, 'erin', 0, 0, 0);
        INSERT INTO transactions (id, from_user_id, to_user_id, amount, type, status, message, created_at) VALUES
            (1, NULL, 1, 1000, 'purchase', 'completed', 'test era', '2026-05-01 10:00:00'),
            (2, NULL, 1, 1000, 'purchase', 'completed', NULL, '2026-07-01 10:00:00'),
            (3, 1, 2, 500, 'donation', 'completed', 'gg', '2026-07-02 10:00:00'),
            (4, NULL, 2, 300, 'donation', 'completed', 'PowerChat tip via site account ($3.00)', '2026-07-03 10:00:00'),
            (5, 2, NULL, 500, 'cashout', 'escrow', 'Cashout to PayPal: bob@example.com', '2026-07-04 10:00:00'),
            (6, 2, NULL, 100, 'cashout', 'refunded', 'Cashout to PayPal: bob@example.com', '2026-07-05 10:00:00'),
            (7, NULL, 3, 250, 'purchase', 'completed', NULL, '2026-07-06 10:00:00'),
            (8, NULL, 4, 100, 'bonus', 'completed', NULL, '2026-07-07 10:00:00'),
            (9, 1, 2, 499, 'subscription', 'completed', NULL, '2026-07-08 10:00:00');
        INSERT INTO payment_orders (id, user_id, provider, provider_ref, kind, amount_cents, bucks, streamer_id, status, created_at) VALUES
            (1, 1, 'powerchat', NULL, 'bucks', 1300, 1000, NULL, 'credited', '2026-07-01 09:59:00'),
            (2, 1, 'stripe', 'cs_dup', 'bucks', 1300, 1000, NULL, 'credited', '2026-07-01 11:00:00'),
            (3, 1, 'stripe', 'cs_dup', 'bucks', 1300, 1000, NULL, 'pending', '2026-07-01 11:05:00'),
            (4, 1, 'powerchat', 'site:fee=50:renew', 'subscription', 549, 0, 2, 'credited', '2026-07-08 09:00:00'),
            (5, 3, 'powerchat', NULL, 'bucks', 325, 250, NULL, 'paid', '2026-07-06 09:00:00');
    `);
    const future = new Date(Date.now() + 20 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
    live.prepare(`INSERT INTO subscriptions (id, subscriber_id, streamer_id, provider, price_cents, status, auto_renew, current_period_end, created_at)
        VALUES (1, 1, 2, 'powerchat', 549, 'active', 1, ?, '2026-07-08 09:00:00'), (2, 4, 2, 'bucks', 499, 'expired', 0, '2026-07-01 00:00:00', '2026-06-01 00:00:00')`).run(future);
    live.close();
    return new Database(file, { readonly: true, fileMustExist: true });
}

(async () => {
    const t = await boot();
    const alice = t.network.addUser(1);
    const bob = t.network.addUser(2);
    const dave = t.network.addUser(4);
    t.network.addUser(5);
    const live = fabricateLive(path.join(t.dir, 'live-snapshot.db'));
    const { importLive } = require('../server/importer/live');
    const { createIdentity } = require('../server/network');
    const identity = createIdentity(t.config);
    const run = (opts = {}) => importLive(t.ctx, { live, resolveLiveUsers: identity.resolveLiveUsers, log: { log() {} }, ...opts });
    const bal = (kind, owner) => { const { balance } = require('../server/ledger'); return balance(t.db, { kind, owner, currency: 'vibes-bits' }); };
    const count = (table) => t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    console.log('import from live.db');

    await check('a dry run reports everything and keeps nothing but its report', async () => {
        const r = await run({ dryRun: true });
        assert.strictEqual(r.dry_run, true);
        assert.ok(r.new_transactions > 0);
        assert.strictEqual(count('transactions'), 0);
        assert.strictEqual(count('payment_intents'), 0);
        assert.strictEqual(t.db.prepare('SELECT dry_run FROM import_runs').get().dry_run, 1);
    });

    let report;
    await check('opening balances equal the Live columns', async () => {
        report = await run();
        assert.strictEqual(bal('user_credit', alice), 1500);
        assert.strictEqual(bal('creator_payable', bob), 700);
        assert.strictEqual(bal('payouts_pending', bob), 500, 'the escrowed cashout sits in payouts_pending');
        assert.strictEqual(bal('user_credit', dave), 101);
        assert.strictEqual(bal('user_credit', 'hold:live:3'), 250);
        assert.ok(t.network.resolveCalls.every((c) => c.system === 'live' && c.type === 'user'));
    });

    await check('differences against the replayed history are import adjustments, listed', async () => {
        const adj = report.adjustments.map((a) => [a.live_user_id, a.account, a.replayed_history, a.live_column, a.adjustment]);
        assert.deepStrictEqual(adj.sort(), [[2, 'creator_payable', 300, 700, 400], [4, 'user_credit', 100, 101, 1]].sort());
        assert.ok(report.anomalies.some((a) => a.kind === 'fractional_balance' && a.live_user_id === 4));
        assert.strictEqual(bal('import_adjustment', null), -401);
    });

    await check('unmapped users are held, never dropped', async () => {
        assert.deepStrictEqual(report.holds.map((h) => [h.live_user_id, h.credit_bits]), [[3, 250]]);
        const hold = t.db.prepare('SELECT * FROM import_holds WHERE live_user_id = 3').get();
        assert.strictEqual(hold.resolved_subject, null);
        const i = t.db.prepare('SELECT subject FROM payment_intents WHERE legacy_order_id = 5').get();
        assert.strictEqual(i.subject, 'hold:live:3');
    });

    await check('history rows become import transactions; test-era rows are flagged test', async () => {
        const txn = (id) => t.db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(`import:live:txn:${id}`);
        assert.deepStrictEqual([txn(1).test, txn(2).test], [1, 0]);
        assert.deepStrictEqual([txn(1).type, txn(1).status], ['import', 'imported']);
        assert.strictEqual(txn(3).created_at, '2026-07-02T10:00:00.000Z');
        assert.ok(report.unreplayable.some((u) => u.live_txn === 9));
        const co = t.db.prepare('SELECT status, amount_bits FROM cashouts ORDER BY legacy_live_txn').all();
        assert.deepStrictEqual(co.map((c) => [c.status, c.amount_bits]), [['requested', 500], ['denied', 100]]);
    });

    await check('payment orders become intents and receipts; duplicate refs and route markers handled', async () => {
        assert.deepStrictEqual(report.duplicate_provider_refs.map((d) => [d.order, d.kept_on_order]), [[3, 2]]);
        assert.strictEqual(report.route_markers, 1);
        const sub = t.db.prepare('SELECT * FROM payment_intents WHERE legacy_order_id = 4').get();
        assert.deepStrictEqual([sub.provider_ref, sub.route, sub.fee_cents, sub.auto_renew, sub.status], [null, 'site', 50, 1, 'settled']);
        assert.strictEqual(t.db.prepare('SELECT status FROM payment_intents WHERE legacy_order_id = 3').get().status, 'expired');
        assert.ok(report.anomalies.some((a) => a.kind === 'order_paid_not_credited' && a.order === 5));
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM provider_events WHERE type = 'live.payment_order'").get().n, 4);
    });

    await check('subscriptions become entitlements', async () => {
        const e = await t.call('GET', `/api/v1/entitlements/${alice}?streamer=${bob}`);
        assert.strictEqual(e.json.active, true);
        assert.strictEqual(e.json.subscription.auto_renew, true);
        const d = await t.call('GET', `/api/v1/entitlements/${dave}?streamer=${bob}`);
        assert.strictEqual(d.json.active, false);
        assert.strictEqual(report.subscriptions.imported, 2);
    });

    await check('the journal reconciles after import', async () => {
        const rec = t.assertReconciled('after import');
        assert.strictEqual(rec.warnings.import_holds.length, 1);
        assert.ok(rec.totals.test_transactions >= 1);
    });

    await check('a re-run over the same snapshot changes nothing', async () => {
        const before = { txns: count('transactions'), entries: count('ledger_entries'), intents: count('payment_intents'), subs: count('subscriptions'), ents: count('entitlements'), cashouts: count('cashouts') };
        const again = await run();
        assert.strictEqual(again.new_transactions, 0);
        assert.deepStrictEqual(again.adjustments, []);
        assert.deepStrictEqual({ txns: count('transactions'), entries: count('ledger_entries'), intents: count('payment_intents'), subs: count('subscriptions'), ents: count('entitlements'), cashouts: count('cashouts') }, before);
        assert.strictEqual(bal('creator_payable', bob), 700);
    });

    await check('a hold is released to the subject once the Network maps the user', async () => {
        const carol = t.network.addUser(3);
        const r = await run();
        assert.deepStrictEqual(r.holds, []);
        assert.strictEqual(bal('user_credit', carol), 250);
        assert.strictEqual(bal('user_credit', 'hold:live:3'), 0);
        assert.strictEqual(t.db.prepare('SELECT resolved_subject FROM import_holds WHERE live_user_id = 3').get().resolved_subject, carol);
        t.assertReconciled('after release');
        assert.strictEqual((await run()).new_transactions, 0);
    });

    live.close();
    await t.close();
    done();
})();
