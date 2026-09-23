'use strict';
/**
 * Hygiene: amounts that would overflow exact integer arithmetic are refused whole; concurrent
 * settlements of one provider payment (same delivery, redeliveries, several processes)
 * settle it once; an outage during settlement (the Network down while a site-routed tip resolves its
 * creator, a failure inside the settlement transaction, OpenVibe.Events down) leaves nothing half
 * done and settles once on recovery; the scheduled reconciliation is stored, pruned and exposed
 * (API, /metrics), and fails on a receipt stuck unprocessed.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');
const { startEvents } = require('./helpers/stubs');

const donation = (data, streamer = 'openvibe') => ({ type: 'donation.completed', streamer: { id: 'pc1', username: streamer }, data: { eventId: `don-${Math.random().toString(36).slice(2)}`, ...data } });

(async () => {
    const t = await boot();
    const buyer = t.user(61);
    const streamer = t.user(62);
    const streamerLiveId = 63;
    const siteStreamer = t.network.addUser(streamerLiveId);
    const intent = async (body) => {
        const r = await t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', ...body } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.intent;
    };
    const txnCount = () => t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
    const providers = require('../server/providers');
    console.log('hygiene');

    // ── Overflow ─────────────────────────────────────────────
    await check('huge provider amounts are rejected for review, never booked', async () => {
        const before = txnCount();
        const i = await intent({ kind: 'purchase', subject: buyer, bits: 100 });
        for (const cents of [1e20, 2 ** 53, 9007199254740993, 100_000_001, -500]) {
            const r = await t.powerchat(donation({ amountUsdCents: cents, appExternalRef: i.checkout_ref }));
            assert.strictEqual(r.status, 200);
            assert.ok(['rejected', 'none'].includes(r.json.result.effect), `${cents}: ${JSON.stringify(r.json.result)}`);
        }
        const tip = await t.powerchat(donation({ amountUsdCents: 1e17, appExternalRef: `pcdon:${streamerLiveId}:0` }));
        assert.strictEqual(tip.json.result.effect, 'rejected');
        assert.strictEqual(tip.json.result.code, 'billing.invalid_amount');
        assert.strictEqual(txnCount(), before);
        t.assertReconciled('after refused huge receipts');
    });

    await check('the API refuses amounts past the exact integer range or the per-call maximum', async () => {
        const settle = await t.call('POST', '/api/v1/purchases/settle', { body: { provider: 'powerchat', provider_ref: 'huge-1', subject: buyer, amount_cents: 9007199254740993, bits: 100 } });
        assert.strictEqual(settle.status, 422);
        assert.strictEqual(settle.json.code, 'billing.invalid_amount');
        const tr = await t.call('POST', '/api/v1/transfers', { body: { from: buyer, to: streamer, amount: 1e300 } });
        assert.strictEqual(tr.status, 422);
        const adj = await t.call('POST', '/api/v1/admin/adjustments', { body: { from: { kind: 'import_adjustment', currency: 'vibes-bits' }, to: { kind: 'user_credit', owner: buyer.id, currency: 'vibes-bits' }, amount: 2 ** 60, reason: 'x' } });
        assert.strictEqual(adj.status, 422);
    });

    await check('the journal refuses a posting whose amount or resulting balance leaves the exact range, as a whole', async () => {
        const { post, balance } = require('../server/ledger');
        const { A, entry } = require('../server/ops/common');
        const acct = A.credit(buyer.id);
        const big = Number.MAX_SAFE_INTEGER - 10;
        assert.throws(() => post(t.ctx, { type: 'adjustment', idempotencyKey: 'ovf-1', entries: [entry(acct, 2 ** 53), entry(A.importAdj('vibes-bits'), -(2 ** 53))] }), /exact integer range/);
        post(t.ctx, { type: 'adjustment', idempotencyKey: 'ovf-2', entries: [entry(acct, big), entry(A.importAdj('vibes-bits'), -big)] });
        const at = balance(t.db, acct);
        const count = txnCount();
        assert.throws(() => post(t.ctx, { type: 'adjustment', idempotencyKey: 'ovf-3', entries: [entry(acct, 100), entry(A.importAdj('vibes-bits'), -100)] }), (e) => e.code === 'billing.amount_overflow');
        assert.strictEqual(balance(t.db, acct), at, 'nothing moved');
        assert.strictEqual(txnCount(), count, 'no transaction row');
        post(t.ctx, { type: 'adjustment', idempotencyKey: 'ovf-4', entries: [entry(acct, -big), entry(A.importAdj('vibes-bits'), big)] });
        t.assertReconciled('after overflow refusals');
    });

    await check('a refund claiming more than was paid reverses at most what was paid', async () => {
        const i = await intent({ kind: 'purchase', subject: buyer, bits: 500 });
        const pay = await t.powerchat(donation({ eventId: 'don-cap', amountUsdCents: 700, appExternalRef: i.checkout_ref }));
        assert.strictEqual(pay.json.result.effect, 'settled');
        const rf = await t.powerchat({ type: 'donation.refunded', streamer: { username: 'openvibe' }, data: { eventId: 'rf-cap', originalEventId: 'don-cap', refundedUsdCents: 1e300 } });
        assert.strictEqual(rf.json.result.effect, 'settled', JSON.stringify(rf.json));
        const tx = (await t.call('GET', `/api/v1/transactions/${rf.json.result.txn_id}`)).json.transaction;
        assert.strictEqual(tx.metadata.cents, 700);
        t.assertReconciled('after an over-claimed refund');
    });

    // ── Concurrent settlement of one provider payment ────────
    await check('20 concurrent copies of one delivery settle it once', async () => {
        const i = await intent({ kind: 'purchase', subject: buyer, bits: 1000 });
        const credit = (await t.balances(buyer.id)).credit;
        const env = donation({ eventId: 'don-race-1', amountUsdCents: 1300, appExternalRef: i.checkout_ref });
        const rs = await Promise.all(Array.from({ length: 20 }, () => t.powerchat(env, { deliveryId: 'dlv-race-1' })));
        assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(','));
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM provider_events WHERE provider_event_id = 'dlv-race-1'").get().n, 1);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE receipt_ref = 'powerchat:don-race-1'").get().n, 1);
        assert.strictEqual((await t.balances(buyer.id)).credit, credit + 1000);
        t.assertReconciled('after a delivery race');
    });

    await check('20 concurrent redeliveries of one payment under different delivery ids settle it once', async () => {
        const credit = (await t.balances(siteStreamer)).payable;
        // pcdon resolves its creator through the Network (async), so the deliveries really interleave.
        const env = donation({ eventId: 'don-race-2', amountUsdCents: 250, appExternalRef: `pcdon:${streamerLiveId}:0` });
        const rs = await Promise.all(Array.from({ length: 20 }, (_, n) => t.powerchat(env, { deliveryId: `dlv-race-2-${n}` })));
        const effects = rs.map((r) => r.json.result.effect).sort();
        assert.strictEqual(effects.filter((e) => e === 'settled').length, 1, effects.join(','));
        assert.strictEqual(effects.filter((e) => e === 'duplicate_receipt').length, 19);
        assert.strictEqual((await t.balances(siteStreamer)).payable, credit + 250);
        t.assertReconciled('after a redelivery race');
    });

    await check('four processes racing on one stored receipt (the service, a script, a retry) settle it once', async () => {
        const i = await intent({ kind: 'purchase', subject: buyer, bits: 500 });
        await t.call('POST', '/api/v1/admin/freeze', { key: null, body: { on: true, reason: 'race test' } });
        const q = await t.powerchat(donation({ eventId: 'don-race-3', amountUsdCents: 700, appExternalRef: i.checkout_ref }), { deliveryId: 'dlv-race-3' });
        assert.strictEqual(q.status, 202);
        require('../server/ops/admin').setFreeze(t.ctx, { on: false });
        const credit = (await t.balances(buyer.id)).credit;
        // Each child opens its own connection to the same database file and, at the same instant,
        // processes the same stored receipt — what the service's retry tick and an operator's
        // unfreeze from scripts/ could do at once.
        const child = `
            const { loadConfig } = require('./server/config');
            const { openDb } = require('./server/db');
            const { createRates } = require('./server/rates');
            const providers = require('./server/providers');
            const config = loadConfig({ NODE_ENV: 'test', BILLING_DB_PATH: process.env.DB, POWERCHAT_WEBHOOK_SECRET: 'pc-secret', POWERCHAT_SITE_USERNAME: 'openvibe' });
            const db = openDb(config.dbPath);
            const ctx = { db, config, rates: createRates(config.rates), now: () => Date.now(), log: { warn: (...a) => console.error(...a) } };
            const adapters = providers.createAdapters(config, {});
            while (Date.now() < Number(process.env.AT)) { /* line up */ }
            providers.process(ctx, adapters, Number(process.env.EVENT)).then((row) => { console.log(JSON.stringify({ processed: !!row.processed_at, result: row.result })); db.close(); });`;
        const { spawn } = require('child_process');
        const at = Date.now() + 1500;
        const run = () => new Promise((resolve) => {
            const c = spawn(process.execPath, ['-e', child], { cwd: require('path').join(__dirname, '..'), env: { ...process.env, DB: t.config.dbPath, AT: String(at), EVENT: String(q.json.event) } });
            let out = '';
            c.stdout.on('data', (d) => { out += d; });
            c.stderr.on('data', (d) => { out += d; });
            c.on('close', (code) => resolve({ code, out }));
        });
        const results = await Promise.all([run(), run(), run(), run()]);
        for (const r of results) {
            assert.strictEqual(r.code, 0, r.out);
            assert.strictEqual(JSON.parse(r.out.trim().split('\n').pop()).processed, true, r.out);
        }
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE receipt_ref = 'powerchat:don-race-3'").get().n, 1);
        const row = t.db.prepare('SELECT attempts, last_error, result FROM provider_events WHERE id = ?').get(q.json.event);
        assert.deepStrictEqual([row.attempts, row.last_error, JSON.parse(row.result).effect], [1, null, 'settled'], 'applied once; the others waited for the lock and found it processed');
        assert.strictEqual((await t.balances(buyer.id)).credit, credit + 500);
        t.assertReconciled('after a multi-process race');
    });

    await check('an operator reprocess racing the retry job does not settle twice', async () => {
        t.network.state.down = true;
        const r = await t.powerchat(donation({ eventId: 'don-race-4', amountUsdCents: 300, appExternalRef: `pcdon:${streamerLiveId}:0` }));
        assert.strictEqual(r.json.processed, false);
        t.network.state.down = false;
        const payable = (await t.balances(siteStreamer)).payable;
        await Promise.all([
            t.call('POST', `/api/v1/admin/provider-events/${r.json.event}/reprocess`, { key: null }),
            providers.processPending(t.ctx, t.app.locals.adapters),
            providers.processPending(t.ctx, t.app.locals.adapters),
        ]);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE receipt_ref = 'powerchat:don-race-4'").get().n, 1);
        assert.strictEqual((await t.balances(siteStreamer)).payable, payable + 300);
    });

    // ── Outages during settlement ────────────────────────────
    let heldEvent;
    await check('the Network down while a site tip resolves its creator: stored, 200 unprocessed, nothing booked, retried later', async () => {
        t.network.state.down = true;
        const before = txnCount();
        const r = await t.powerchat(donation({ eventId: 'don-out-1', amountUsdCents: 400, appExternalRef: `pcdon:${streamerLiveId}:0` }), { deliveryId: 'dlv-out-1' });
        assert.strictEqual(r.status, 200, 'acknowledged: the receipt is stored, PowerChat must not retry forever');
        assert.strictEqual(r.json.processed, false);
        heldEvent = r.json.event;
        const row = t.db.prepare('SELECT * FROM provider_events WHERE id = ?').get(heldEvent);
        assert.strictEqual(row.processed_at, null);
        assert.ok(row.last_error, 'the failure is recorded');
        assert.strictEqual(txnCount(), before);
        const pending = await providers.processPending(t.ctx, t.app.locals.adapters);
        assert.strictEqual(pending.processed, 0, 'still down: still pending');
        const rec = t.assertReconciled('with a pending receipt');
        assert.strictEqual(rec.warnings.unprocessed_events.length, 1);
    });

    await check('a receipt stuck past BILLING_RECONCILE_STALE_RECEIPT_MIN fails reconciliation (not while frozen)', async () => {
        const { reconcile } = require('../server/reconcile');
        t.clock.offset = 61 * 60_000;
        const r = reconcile(t.ctx, { store: false });
        const stale = r.checks.find((c) => c.id === 'receipts.stale');
        assert.strictEqual(stale.ok, false);
        assert.deepStrictEqual(stale.detail.offenders.map((o) => o.id), [heldEvent]);
        require('../server/ops/admin').setFreeze(t.ctx, { on: true, reason: 'x' });
        assert.strictEqual(reconcile(t.ctx, { store: false }).checks.find((c) => c.id === 'receipts.stale').ok, true, 'held on purpose while frozen');
        require('../server/ops/admin').setFreeze(t.ctx, { on: false });
        const m = await fetch(`${t.base}/metrics`).then((x) => x.text());
        assert.match(m, /billing_provider_event_oldest_pending_seconds (36[6-9]\d|3[7-9]\d\d)/);
        t.clock.offset = 0;
    });

    await check('the Network back: the retry job settles the held receipt once', async () => {
        t.network.state.down = false;
        const payable = (await t.balances(siteStreamer)).payable;
        const out = await providers.processPending(t.ctx, t.app.locals.adapters);
        assert.strictEqual(out.processed, 1);
        await providers.processPending(t.ctx, t.app.locals.adapters);
        assert.strictEqual((await t.balances(siteStreamer)).payable, payable + 400);
        const row = t.db.prepare('SELECT attempts, last_error, result FROM provider_events WHERE id = ?').get(heldEvent);
        assert.strictEqual(JSON.parse(row.result).effect, 'settled');
        assert.strictEqual(row.last_error, null);
        t.assertReconciled('after recovery');
    });

    await check('a failure inside the settlement transaction rolls everything back; the retry settles once', async () => {
        const intents = require('../server/ops/intents');
        const i = await intent({ kind: 'purchase', subject: buyer, bits: 100 });
        const before = txnCount();
        const credit = (await t.balances(buyer.id)).credit;
        const real = intents.markSettled;
        let fails = 1;
        // Marking the intent settled comes after the journal posting, in the same transaction: failing
        // it must take the posting, the outbox event and the processed mark down with it.
        intents.markSettled = (...a) => { if (fails-- > 0) throw new Error('disk full'); return real(...a); };
        const events = t.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
        let r;
        try { r = await t.powerchat(donation({ eventId: 'don-crash', amountUsdCents: 150, appExternalRef: i.checkout_ref })); }
        finally { intents.markSettled = real; }
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, events, 'no event for a settlement that did not happen');
        assert.strictEqual(r.json.processed, false);
        assert.strictEqual(txnCount(), before);
        assert.strictEqual((await t.balances(buyer.id)).credit, credit);
        assert.strictEqual((await t.call('GET', `/api/v1/intents/${i.id}`)).json.intent.status, 'created');
        assert.match(t.db.prepare('SELECT last_error FROM provider_events WHERE id = ?').get(r.json.event).last_error, /disk full/);
        await providers.processPending(t.ctx, t.app.locals.adapters);
        assert.strictEqual((await t.balances(buyer.id)).credit, credit + 100);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE receipt_ref = 'powerchat:don-crash'").get().n, 1);
        t.assertReconciled('after a mid-settlement failure');
    });

    await check('OpenVibe.Events down: settlement is unaffected, events wait in the outbox and go out once it is back', async () => {
        const { createRelay } = require('../server/outbox');
        const log = { warn() {} };
        const unsent = () => t.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get().n;
        const down = createRelay({ db: t.db, config: { ...t.config, events: { url: 'http://127.0.0.1:9', intervalMs: 1000 } }, log });
        await fund(t, buyer, 200);
        const r = await down.flush();
        assert.strictEqual(r.sent, 0);
        const waiting = unsent();
        assert.ok(waiting > 0);
        const m = await fetch(`${t.base}/metrics`).then((x) => x.text());
        assert.match(m, new RegExp(`billing_outbox_pending ${waiting}\\b`));
        assert.match(m, /billing_outbox_failing [1-9]/);
        const events = await startEvents();
        const up = createRelay({ db: t.db, config: { ...t.config, events: { url: events.url, intervalMs: 1000 } }, log });
        await up.flush();
        assert.strictEqual(unsent(), 0);
        const ids = events.batches.flatMap((b) => b.events).map((e) => e.event_id);
        assert.strictEqual(new Set(ids).size, ids.length, 'each event published once');
        await events.close();
    });

    // ── Scheduled reconciliation, exposed ────────────────────
    await check('the scheduled run is stored with its trigger, listed by the API and old passing runs are pruned', async () => {
        const { runScheduled } = require('../server/reconcile');
        const old = runScheduled({ ...t.ctx, now: () => Date.now() - 40 * 86_400_000 }, { keepDays: 0 });
        assert.strictEqual(old.ok, true);
        const rep = runScheduled(t.ctx, { keepDays: 30 });
        assert.strictEqual(rep.trigger, 'scheduled');
        assert.ok(rep.checks.some((c) => c.id === 'receipts.ledger' && c.ok));
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_runs WHERE id = ?').get(old.id).n, 0, 'a 40-day-old passing scheduled run is pruned');
        const list = await t.call('GET', '/api/v1/admin/reconciliations?limit=5', { cap: ['billing.ledger.admin'] });
        assert.strictEqual(list.status, 200, list.text);
        assert.deepStrictEqual([list.json.runs[0].id, list.json.runs[0].trigger, list.json.runs[0].ok], [rep.id, 'scheduled', true]);
        const latest = await t.call('GET', '/api/v1/admin/reconciliations/latest');
        assert.strictEqual(latest.json.id, rep.id);
        assert.ok(latest.json.checks.length >= 10);
        assert.strictEqual((await t.call('GET', '/api/v1/admin/reconciliations/latest', { cap: ['billing.balance.read'] })).status, 403);
        assert.strictEqual((await t.call('GET', '/api/v1/admin/reconciliations/rec_nope')).status, 404);
    });

    await check('a failed run is kept and shows on /metrics; the ledger-vs-receipts check catches a wrong clearing amount', async () => {
        const { runScheduled } = require('../server/reconcile');
        // A settlement whose clearing entry disagrees with the receipt it names.
        const { post } = require('../server/ledger');
        const { A, entry } = require('../server/ops/common');
        const ev = t.db.prepare("INSERT INTO provider_events (provider, provider_event_id, type, payload_hash, payload, received_at, processed_at, result) VALUES ('powerchat', 'forged', 'donation.completed', 'x', '{}', ?, ?, ?)")
            .run(new Date().toISOString(), new Date().toISOString(), JSON.stringify({ effect: 'settled' })).lastInsertRowid;
        post(t.ctx, {
            type: 'purchase', idempotencyKey: 'forged-1', provider: 'powerchat', receiptRef: 'powerchat:forged', sourceEventId: Number(ev), toSubject: buyer.id,
            entries: [entry(A.clearing('powerchat'), -100), entry(A.fxCents(), 100), entry(A.fxBits(), -100), entry(A.credit(buyer.id), 100)],
            metadata: { paid_cents: 900, bits: 100, rates: { bits_per_usd: 100 } },
        });
        const rep = runScheduled({ ...t.ctx, log: { warn() {} } }, { keepDays: 30 });
        assert.strictEqual(rep.ok, false);
        const c = rep.checks.find((x) => x.id === 'receipts.ledger');
        assert.strictEqual(c.ok, false);
        assert.deepStrictEqual(c.detail.offenders.map((o) => [o.receipt_ref, o.clearing, o.paid_cents]), [['powerchat:forged', -100, 900]]);
        runScheduled({ ...t.ctx, log: { warn() {} } }, { keepDays: 0 });
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM reconciliation_runs WHERE id = ?').get(rep.id).n, 1, 'failed runs are never pruned');
        const m = await fetch(`${t.base}/metrics`).then((x) => x.text());
        assert.match(m, /^billing_reconciliation_ok 0$/m);
        assert.match(m, /^billing_reconciliation_failed_checks 1$/m);
        assert.match(m, /^billing_reconciliation_last_run_timestamp_seconds \d{10}$/m);
        const failed = await t.call('GET', '/api/v1/admin/reconciliations?failed=1');
        assert.ok(failed.json.runs.every((r) => !r.ok) && failed.json.runs.length >= 1);
    });

    await check('/metrics: golden signals and Billing gauges for loopback callers, 404 for anything relayed', async () => {
        const res = await fetch(`${t.base}/metrics`);
        assert.strictEqual(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        const m = await res.text();
        for (const name of ['http_requests_total', 'release_info', 'billing_frozen 0', 'billing_authority{authority="live"} 1', 'billing_provider_events{provider="powerchat",state="settled"}',
            'billing_external_receipts{status="announced"} 0', 'billing_cashouts{status="requested"} 0']) {
            assert.ok(m.includes(name), `missing ${name}`);
        }
        assert.ok(!/usr_[0-9A-Z]{26}/.test(m), 'no subject ever appears in metrics');
        const relayed = await fetch(`${t.base}/metrics`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
        assert.strictEqual(relayed.status, 404);
        const real = await fetch(`${t.base}/metrics`, { headers: { 'X-Real-IP': '203.0.113.9' } });
        assert.strictEqual(real.status, 404);
    });

    await t.close();
    done();
})();
