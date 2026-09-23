'use strict';
/** The journal itself: balance invariant, append-only, idempotent posting, cached balances. */
const assert = require('assert');
const { openDb } = require('../server/db');
const { loadConfig } = require('../server/config');
const { createRates } = require('../server/rates');
const { post, balance, BillingError } = require('../server/ledger');
const { A, entry } = require('../server/ops/common');
const { reconcile } = require('../server/reconcile');
const { check, done } = require('./helpers/app');

const db = openDb(':memory:');
const config = loadConfig({ NODE_ENV: 'test' });
const ctx = { db, config, rates: createRates(config.rates), now: () => Date.now() };
const U = 'usr_01JAAAAAAAAAAAAAAAAAAAAAAA';

(async () => {
    console.log('ledger');

    await check('an unbalanced transaction is refused and leaves nothing behind', () => {
        assert.throws(() => post(ctx, { type: 'adjustment', idempotencyKey: 'k1', entries: [entry(A.credit(U), 5), entry(A.importAdj('vibes-bits'), -4)] }),
            (e) => e instanceof BillingError && e.code === 'ledger.unbalanced');
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, 0);
        assert.strictEqual(balance(db, A.credit(U)), 0);
    });

    await check('balance is per currency: bits and cents never net against each other', () => {
        assert.throws(() => post(ctx, { type: 'adjustment', idempotencyKey: 'k2', entries: [entry(A.credit(U), 5), entry(A.refunds(), -5)] }),
            (e) => e.code === 'ledger.unbalanced');
    });

    await check('a balanced transaction moves the cached balances', () => {
        const { txn } = post(ctx, { type: 'adjustment', idempotencyKey: 'k3', entries: [entry(A.credit(U), 70), entry(A.importAdj('vibes-bits'), -70)] });
        assert.strictEqual(txn.entries.length, 2);
        assert.strictEqual(balance(db, A.credit(U)), 70);
        assert.strictEqual(balance(db, A.importAdj('vibes-bits')), -70);
    });

    await check('posting the same idempotency key again returns the original and moves nothing', () => {
        const first = db.prepare("SELECT id FROM transactions WHERE idempotency_key = 'k3'").get().id;
        const r = post(ctx, { type: 'adjustment', idempotencyKey: 'k3', entries: [entry(A.credit(U), 999), entry(A.importAdj('vibes-bits'), -999)] });
        assert.strictEqual(r.replay, true);
        assert.strictEqual(r.txn.id, first);
        assert.strictEqual(balance(db, A.credit(U)), 70);
    });

    await check('ledger entries and transactions cannot be updated or deleted', () => {
        assert.throws(() => db.prepare('UPDATE ledger_entries SET amount = amount + 1').run(), /append-only/);
        assert.throws(() => db.prepare('DELETE FROM ledger_entries').run(), /append-only/);
        assert.throws(() => db.prepare("UPDATE transactions SET status = 'imported'").run(), /append-only/);
        assert.throws(() => db.prepare('DELETE FROM transactions').run(), /append-only/);
    });

    await check('platform accounts (no owner) are unique despite NULL owners', () => {
        post(ctx, { type: 'adjustment', idempotencyKey: 'k4', entries: [entry(A.refunds(), 1), entry(A.loss(), -1)] });
        post(ctx, { type: 'adjustment', idempotencyKey: 'k5', entries: [entry(A.refunds(), 1), entry(A.loss(), -1)] });
        assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'refunds'").get().n, 1);
        assert.throws(() => db.prepare("INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES ('refunds', NULL, 'usd-cents', 'x')").run(), /UNIQUE/);
    });

    await check('rates: tiers price like Live and invert without overcharging', () => {
        const r = ctx.rates;
        assert.strictEqual(r.priceCents(100), 150);
        assert.strictEqual(r.priceCents(1000), 1300);
        assert.strictEqual(r.priceCents(25000), 27500);
        assert.strictEqual(r.bitsForPriceCents(1300), 1000);
        assert.strictEqual(r.bitsForPriceCents(149), 99);
        for (const c of [50, 150, 700, 1299, 1300, 3100, 27500, 99999]) assert.ok(r.priceCents(r.bitsForPriceCents(c)) <= c, `price of bits for ${c}`);
        assert.strictEqual(r.subShareBits(499), 349);       // Live: bucksForUsd(4.99 * 0.70)
        assert.strictEqual(r.siteFeeCents(499), 50);        // Live: round(499 * 10 / 100)
    });

    await check('reconciliation passes on a consistent journal and catches a corrupted cache', () => {
        assert.strictEqual(reconcile(ctx).ok, true);
        db.prepare("UPDATE account_balances SET balance = balance + 1 WHERE account_id = (SELECT id FROM accounts WHERE kind = 'user_credit')").run();
        const r = reconcile(ctx);
        assert.strictEqual(r.ok, false);
        const c = r.checks.find((x) => x.id === 'balances.cache');
        assert.strictEqual(c.ok, false);
        assert.strictEqual(c.detail.mismatches[0].cached - c.detail.mismatches[0].derived, 1);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM reconciliation_runs WHERE ok = 0').get().n, 1);
    });

    done();
})();
