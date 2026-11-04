'use strict';
/**
 * Credits: the prepaid USD balance for metered services (AI Exchange D1, D2; migrations/0011_inference_subledger.sql, ops/inference.js,
 * api/internal.js): holds, extends, settlements and releases in nano-USD, behind BILLING_CREDITS.
 * Sandbox grants are behind BILLING_CREDITS_SANDBOX and land in the person's own sandbox account, which only a hold
 * marked sandbox spends (D10). Real credit comes from a top-up; until checkout funding exists, `fund()` below books
 * one straight through the ledger. Nothing here touches chargeFor or Vibes bits.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const inference = require('../server/ops/credits');
const { post } = require('../server/ledger');

const INF = ['billing.credit.hold.create', 'billing.credit.hold.extend', 'billing.credit.hold.settle', 'billing.credit.hold.release'];
const SBX = ['billing.credit.sandbox.grant'];
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';

function retail(over = {}) {
    return {
        version: 'rc-v1',
        nano_usd_per_m: { input: '1000', cached_read: '500', cache_write: '2000', output: '3000' },
        per_request_nano_usd: '100',
        ...over,
    };
}

const RATE_CARD = retail();

function usage(u = {}) {
    return { input_tokens: 0, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, ...u };
}

function settleBody(u, over = {}) {
    return {
        idempotency_key: `settle:${crypto.randomBytes(8).toString('hex')}`,
        usage: usage(u),
        retail: RATE_CARD,
        supply_cost_nano_usd: '0',
        byok: false,
        attempts: [],
        ...over,
    };
}

function holdBody(subject, max, over = {}) {
    return {
        idempotency_key: `hold:${crypto.randomBytes(8).toString('hex')}`,
        subject: { type: 'user', id: subject.id },
        project_id: PRJ,
        max_nano_usd: String(max),
        rate_version: 'rc-v1',
        request_fingerprint: crypto.randomBytes(8).toString('hex'),
        ...over,
    };
}

async function assertJournalBalances(db, label) {
    const rows = await db.prepare(`SELECT a.currency, SUM(e.amount)::text AS total FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id GROUP BY a.currency`).all();
    for (const r of rows) {
        assert.strictEqual(String(r.total), '0', `journal not balanced for ${r.currency} ${label}: ${r.total}`);
    }
}

(async () => {
    console.log('credits ledger');
    const t = await boot({ env: { BILLING_CREDITS: '1', BILLING_CREDITS_SANDBOX: '1' } });
    const create = (body, opts = {}) => t.call('POST', '/internal/credits/holds', { body, cap: INF, sub: 'svc:ai', ...opts });
    const extend = (id, add, opts = {}) => t.call('POST', `/internal/credits/holds/${id}/extend`, { body: { add_nano_usd: String(add) }, cap: INF, sub: 'svc:ai', ...opts });
    const settle = (id, body, opts = {}) => t.call('POST', `/internal/credits/holds/${id}/settle`, { body, cap: INF, sub: 'svc:ai', ...opts });
    const release = (id, opts = {}) => t.call('POST', `/internal/credits/holds/${id}/release`, { body: {}, cap: INF, sub: 'svc:ai', ...opts });
    const grant = (body, opts = {}) => t.call('POST', '/internal/credits/sandbox/grants', { body, cap: SBX, sub: 'svc:ai', ...opts });
    // A real top-up, booked the way checkout funding will book one (money received at the provider -> the person's Credits).
    const fund = (user, amount) => post(t.ctx, {
        type: 'credit', idempotencyKey: `test:fund:${crypto.randomBytes(8).toString('hex')}`, test: true,
        actor: { type: 'service', id: 'billing' }, toSubject: user.id,
        entries: [
            { kind: 'provider_clearing', owner: 'stripe', currency: 'nano-usd', amount: -BigInt(amount) },
            { ...inference.A_INF.credit(user.id, PRJ), amount: BigInt(amount) },
        ],
        metadata: { credit: 'test_top_up' },
    });

    const alice = t.user(1);

    await check('sandbox grant creates an inference credit account and is marked test', async () => {
        const r = await fund(alice, '100000');
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.amount_nano_usd, '100000');
        assert.strictEqual(r.json.balance_nano_usd, '100000');
        const txn = await t.db.prepare("SELECT * FROM transactions WHERE idempotency_key = ?").get(`credit:sandbox:${r.json.grant_id}`);
        assert.strictEqual(txn.test, 1);
        const entries = (await t.db.prepare('SELECT a.kind, a.owner_subject AS owner, a.currency, e.amount::text AS amount FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE e.txn_id = ?').all(txn.id));
        assert.deepStrictEqual(entries.map((e) => [e.kind, e.owner, e.currency, e.amount]).sort(),
            [['usd_credit_sandbox', `${alice.id}:${PRJ}`, 'nano-usd', '100000'], ['usd_credit_sandbox', null, 'nano-usd', '-100000']]);
        await assertJournalBalances(t.db, 'after sandbox grant');
    });

    await check('create hold returns 201 with held, available and lease; 402 when balance is short', async () => {
        await fund(alice, '100000');
        const r = await create(holdBody(alice, 50000));
        assert.strictEqual(r.status, 201, r.text);
        assert.match(r.json.hold_id, /^hld_/);
        assert.strictEqual(r.json.held_nano_usd, '50000');
        assert.strictEqual(r.json.available_nano_usd, '50000');
        assert.ok(new Date(r.json.lease_expires_at).getTime() > Date.now());
        const poor = t.user(2);
        const denied = await create(holdBody(poor, 1));
        assert.strictEqual(denied.status, 402, denied.text);
        assert.strictEqual(denied.json.code, 'billing.insufficient_funds');
    });

    await check('same idempotency key + same fingerprint replays the same hold; different fingerprint is 409', async () => {
        const bob = t.user(3);
        await fund(bob, '10000');
        const body = holdBody(bob, 5000);
        const first = await create(body);
        assert.strictEqual(first.status, 201, first.text);
        const replay = await create(body);
        assert.strictEqual(replay.status, 200, replay.text);
        assert.strictEqual(replay.json.hold_id, first.json.hold_id);
        const changed = await create({ ...body, request_fingerprint: 'different-fp' });
        assert.strictEqual(changed.status, 409, changed.text);
        assert.strictEqual(changed.json.code, 'billing.hold_key_reused');
    });

    await check('extend grows the hold; cannot extend beyond available balance', async () => {
        const carol = t.user(4);
        await fund(carol, '20000');
        const h = await create(holdBody(carol, 5000));
        const ext = await extend(h.json.hold_id, 5000);
        assert.strictEqual(ext.status, 200, ext.text);
        assert.strictEqual(ext.json.held_nano_usd, '10000');
        const over = await extend(h.json.hold_id, 20000);
        assert.strictEqual(over.status, 402, over.text);
        assert.strictEqual(over.json.code, 'billing.insufficient_funds');
    });

    await check('4-component rounding: ceil once per component per request matches worked example', async () => {
        // input 1,500,000 tokens @ 1000/m = ceil(1500000*1000/1e6) = 1500 nano
        // cached_read 2,000,000 @ 500/m = ceil(2000000*500/1e6) = 1000 nano
        // cache_write 1 @ 2000/m = ceil(1*2000/1e6) = 1 nano
        // output 1 @ 3000/m = ceil(1*3000/1e6) = 1 nano
        // per_request = 100
        // total = 2602 nano
        const dave = t.user(5);
        await fund(dave, '10000000');
        const h = await create(holdBody(dave, 10000000));
        const s = await settle(h.json.hold_id, settleBody({ input_tokens: 1500000, cached_read_tokens: 2000000, cache_write_tokens: 1, output_tokens: 1 }));
        assert.strictEqual(s.status, 201, s.text);
        assert.strictEqual(s.json.charge_nano_usd, '2602');
        assert.strictEqual(s.json.released_nano_usd, '9997398');
    });

    await check('BYOK charges 0 regardless of usage', async () => {
        const erin = t.user(6);
        await fund(erin, '100000');
        const h = await create(holdBody(erin, 50000));
        const s = await settle(h.json.hold_id, settleBody({ input_tokens: 1000000, output_tokens: 1000000 }, { byok: true }));
        assert.strictEqual(s.status, 201, s.text);
        assert.strictEqual(s.json.charge_nano_usd, '0');
        assert.strictEqual(s.json.released_nano_usd, '50000');
    });

    await check('settle replay charges once and releases the rest exactly once', async () => {
        const frank = t.user(7);
        await fund(frank, '100000');
        const h = await create(holdBody(frank, 50000));
        const body = settleBody({ input_tokens: 1000, output_tokens: 1000 });
        const s1 = await settle(h.json.hold_id, body);
        assert.strictEqual(s1.status, 201, s1.text);
        // 1000 input @ 1000/m = 1; 1000 output @ 3000/m = 3; per_request 100 => 104
        assert.strictEqual(s1.json.charge_nano_usd, '104');
        assert.strictEqual(s1.json.released_nano_usd, '49896');
        const s2 = await settle(h.json.hold_id, body);
        assert.strictEqual(s2.status, 200, s2.text);
        assert.strictEqual(s2.json.settlement_id, s1.json.settlement_id);
        assert.strictEqual(s2.json.journal_id, s1.json.journal_id);
        const txns = await t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'credit' AND idempotency_key = ?").get(`credit:settle:${body.idempotency_key}`);
        assert.strictEqual(Number(txns.n), 1);
    });

    await check('aborted stream charges only partial usage and releases the unused hold', async () => {
        const gina = t.user(8);
        await fund(gina, '100000');
        const h = await create(holdBody(gina, 50000));
        const s = await settle(h.json.hold_id, settleBody({ input_tokens: 100, output_tokens: 0 }));
        assert.strictEqual(s.status, 201, s.text);
        // 100 input @ 1000/m = ceil(100*1000/1e6) = 1; per_request 100 => 101
        assert.strictEqual(s.json.charge_nano_usd, '101');
        assert.strictEqual(s.json.released_nano_usd, '49899');
        const bal = await t.db.prepare("SELECT b.balance::text AS balance FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.kind = 'usd_credit' AND a.owner_subject = ?").get(`${gina.id}:${PRJ}`);
        assert.strictEqual(String(bal.balance), '99899'); // credit balance reduced by the charge; the rest of the hold is released
    });

    await check('release returns the held amount and is idempotent', async () => {
        const hank = t.user(9);
        await fund(hank, '100000');
        const h = await create(holdBody(hank, 30000));
        const r1 = await release(h.json.hold_id);
        assert.strictEqual(r1.status, 200, r1.text);
        assert.strictEqual(r1.json.released_nano_usd, '30000');
        const r2 = await release(h.json.hold_id);
        assert.strictEqual(r2.status, 200, r2.text);
        assert.strictEqual(r2.json.released_nano_usd, '30000');
        const row = await t.db.prepare('SELECT status FROM credit_holds WHERE id = ?').get(h.json.hold_id);
        assert.strictEqual(row.status, 'released');
    });

    await check('expired lease is released by the sweeper', async () => {
        const ivy = t.user(10);
        await fund(ivy, '100000');
        const h = await create(holdBody(ivy, 10000));
        t.clock.offset += 600 * 1000; // default lease is 300s; advance past it
        const out = await inference.sweepExpired(t.ctx);
        assert.ok(out.released >= 1, `expected at least 1 release, got ${out.released}; the hold answered ${h.status} ${JSON.stringify(h.json).slice(0, 300)}`);
        const row = await t.db.prepare('SELECT status FROM credit_holds WHERE id = ?').get(h.json.hold_id);
        assert.strictEqual(row.status, 'expired');
    });

    await check('100 concurrent holds on a balance that fits 7 succeed exactly 7 times and never go negative', async () => {
        const jack = t.user(11);
        await fund(jack, '70000');
        const key = `concurrent:${crypto.randomBytes(8).toString('hex')}`;
        const holds = await Promise.all(Array.from({ length: 100 }, (_, i) => create({
            idempotency_key: `${key}:${i}`,
            subject: { type: 'user', id: jack.id },
            project_id: PRJ,
            max_nano_usd: '10000',
            rate_version: 'rc-v1',
            request_fingerprint: `fp-${i}`,
        })));
        const succeeded = holds.filter((r) => r.status === 201).length;
        assert.strictEqual(succeeded, 7, `expected 7 holds, got ${succeeded}`);
        const bal = await t.db.prepare("SELECT b.balance::text AS balance FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.kind = 'usd_credit' AND a.owner_subject = ?").get(`${jack.id}:${PRJ}`);
        assert.strictEqual(String(bal.balance), '70000');
        const held = await t.db.prepare("SELECT COALESCE(SUM(held_nano_usd), 0)::text AS held FROM credit_holds WHERE account_id = (SELECT id FROM accounts WHERE kind = 'usd_credit' AND owner_subject = ?) AND status IN ('active', 'extended')").get(`${jack.id}:${PRJ}`);
        assert.strictEqual(String(held.held), '70000');
        assert.ok(holds.every((r) => r.status === 201 || r.json.code === 'billing.insufficient_funds'));
    });

    await check('usage beyond the hold takes the free balance, never below zero, and records the shortfall', async () => {
        const omar = t.user(15);
        await fund(omar, '3000');
        const h = await create(holdBody(omar, 1000));
        // The request turned out to cost 5,000 nano (a per-request fee here), against 1,000 held and 3,000 funded in all.
        const rate = retail({ nano_usd_per_m: { input: '0', cached_read: '0', cache_write: '0', output: '0' }, per_request_nano_usd: '5000' });
        const s = await settle(h.json.hold_id, settleBody({ input_tokens: 0, output_tokens: 0 }, { retail: rate }));
        assert.strictEqual(s.status, 201, s.text);
        assert.strictEqual(s.json.charge_nano_usd, '3000', 'collected: the hold and the free balance');
        assert.strictEqual(s.json.shortfall_nano_usd, '2000', 'owed, not collected, and recorded');
        assert.strictEqual(s.json.released_nano_usd, '0');
        const bal = await t.db.prepare("SELECT b.balance::text AS balance FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.kind = 'usd_credit' AND a.owner_subject = ?").get(`${omar.id}:${PRJ}`);
        assert.strictEqual(String(bal.balance), '0', 'never below zero');
    });

    await check('a person reads their own Credits statement: balance, held, available, charges without content', async () => {
        const lena = t.user(13);
        await fund(lena, '100000');
        const open = await create(holdBody(lena, 20000));
        const done = await create(holdBody(lena, 10000));
        await settle(done.json.hold_id, settleBody({ input_tokens: 1000, output_tokens: 1000 }, { attempts: [{ deployment_id: 'own:qwen/qwen3-4b:q4_k_m@3f2a1c9', provider_access: 'OWN_DEPLOYMENT', started_at: new Date().toISOString(), ended_at: new Date().toISOString() }] }));
        const token = t.network.signUser({ subject_id: lena.id, username: 'lena' });
        const read = (q, tok = token) => fetch(`${t.base}/api/me/credits${q}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
        const r = await read(`?project_id=${PRJ}`);
        assert.strictEqual(r.status, 200, await r.clone().text());
        const doc = await r.json();
        assert.strictEqual(doc.balance_nano_usd, String(100000 - 104));
        assert.strictEqual(doc.held_nano_usd, '20000', 'the open hold is held');
        assert.strictEqual(doc.available_nano_usd, String(100000 - 104 - 20000));
        assert.strictEqual(doc.charges.length, 1);
        assert.strictEqual(doc.charges[0].charge_nano_usd, '104');
        assert.strictEqual(doc.charges[0].model, 'qwen/qwen3-4b:q4_k_m@3f2a1c9');
        assert.strictEqual(doc.charges[0].service, 'ai');
        assert.ok(open.json.hold_id);
        assert.strictEqual((await read(`?project_id=${PRJ}`, null)).status, 401, 'a token is needed');
        assert.strictEqual((await read('?project_id=nope')).status, 422);
        const other = t.network.signUser({ subject_id: t.user(14).id, username: 'mo' });
        const theirs = await (await read(`?project_id=${PRJ}`, other)).json();
        assert.strictEqual(theirs.balance_nano_usd, '0', 'another person sees only their own (empty) account');
    });

    await check('a body that is not the contract\'s is refused with 422 before anything is held', async () => {
        const kim = t.user(14);
        await fund(kim, '100000');
        const before = await t.db.prepare('SELECT COUNT(*)::int AS n FROM credit_holds').get();
        const bad = await create({ ...holdBody(kim, 1000), max_nano_usd: 1000 });   // a number, not a decimal string
        assert.strictEqual(bad.status, 422, JSON.stringify(bad.json));
        assert.strictEqual(bad.json.code, 'billing.invalid_request');
        const extra = await create({ ...holdBody(kim, 1000), surprise: true });
        assert.strictEqual(extra.status, 422, 'an unknown field is refused');
        const after = await t.db.prepare('SELECT COUNT(*)::int AS n FROM credit_holds').get();
        assert.strictEqual(after.n, before.n, 'nothing was held');
        const ok = await create(holdBody(kim, 1000));
        const settled = await settle(ok.json.hold_id, settleBody({ output_tokens: 10 }, { attempts: [{ provider: 'own', model: 'x' }] }));
        assert.strictEqual(settled.status, 422, 'attempts carry the contract fields only (deployment_id, provider_access, times)');
    });

    await check('sandbox credit pays only a sandbox hold, and its charge returns to the issuer (D10)', async () => {
        const sam = t.user(15);
        await grant({ subject: { type: 'user', id: sam.id }, project_id: PRJ, amount_nano_usd: '50000' });
        const real = await create(holdBody(sam, 1000));
        assert.strictEqual(real.status, 402, 'a real hold never spends sandbox credit');
        const revenueBefore = await t.db.prepare("SELECT COALESCE(SUM(b.balance), 0)::text AS v FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.kind = 'platform_revenue' AND a.currency = 'nano-usd'").get();
        const boxed = await create(holdBody(sam, 10000, { sandbox: true }));
        assert.strictEqual(boxed.status, 201, boxed.text);
        const done2 = await settle(boxed.json.hold_id, settleBody({ input_tokens: 1000, output_tokens: 1000 }));
        assert.strictEqual(done2.status, 201, done2.text);
        const revenueAfter = await t.db.prepare("SELECT COALESCE(SUM(b.balance), 0)::text AS v FROM accounts a JOIN account_balances b ON b.account_id = a.id WHERE a.kind = 'platform_revenue' AND a.currency = 'nano-usd'").get();
        assert.strictEqual(revenueAfter.v, revenueBefore.v, 'a sandbox charge is not revenue');
        const token = t.network.signUser({ subject_id: sam.id, username: 'sam' });
        const doc = await (await fetch(`${t.base}/api/me/credits?project_id=${PRJ}`, { headers: { Authorization: `Bearer ${token}` } })).json();
        assert.strictEqual(doc.balance_nano_usd, '0', 'the real balance does not include sandbox credit');
        assert.strictEqual(doc.sandbox.balance_nano_usd, String(50000 - 104), 'the sandbox balance is shown apart');
        assert.strictEqual(doc.charges.length, 0, 'sandbox charges are not on the real statement');
    });

    await check('each settlement announces billing.credit.settled for aggregates, with no subject or project', async () => {
        const tom = t.user(16);
        await fund(tom, '100000');
        const h = await create(holdBody(tom, 10000));
        const at = new Date().toISOString();
        const s2 = await settle(h.json.hold_id, settleBody({ input_tokens: 1000, output_tokens: 1000 }, {
            attempts: [{ deployment_id: 'own:qwen/qwen3-4b:q4_k_m@3f2a1c9', provider_access: 'OWN_DEPLOYMENT', started_at: at, ended_at: at }],
        }));
        assert.strictEqual(s2.status, 201, s2.text);
        const ev = await t.db.prepare("SELECT envelope FROM service_outbox WHERE envelope->>'event_type' = 'billing.credit.settled' AND envelope->'payload'->>'hold_id' = ?").get(h.json.hold_id);
        assert.ok(ev, 'the event is in the outbox, in the settle transaction');
        const env = typeof ev.envelope === 'string' ? JSON.parse(ev.envelope) : ev.envelope;
        const pl = env.payload;
        assert.strictEqual(pl.deployment_id, 'own:qwen/qwen3-4b:q4_k_m@3f2a1c9');
        assert.strictEqual(pl.provider_access, 'OWN_DEPLOYMENT');
        assert.strictEqual(pl.charge_nano_usd, '104');
        assert.strictEqual(pl.sandbox, false);
        for (const k of ['subject', 'project_id', 'account_id']) assert.ok(!(k in pl), `no ${k} in the event`);
        const v = require('openvibe-contracts').validate('billing.credit.settled@1', pl);
        assert.ok(v.valid, `the payload is the contract's: ${JSON.stringify(v.errors)}`);
    });

    await check('the journal balances after all inference operations', async () => {
        await assertJournalBalances(t.db, 'end of inference tests');
    });

    await check('the old chargeFor amplification for tiny usage does not affect the subledger', async () => {
        // Old chargeFor: 1 token at $0.000001/m (1 nano/token) with bitsPerUsd=100 rounds up to 1 bit = $0.01.
        // Subledger: 1 token at 1 nano/m = 1 nano-USD = $0.000000001, with no per-component minimum.
        const kate = t.user(12);
        await fund(kate, '1000');
        const h = await create(holdBody(kate, 1000));
        const rate = retail({ nano_usd_per_m: { input: '1', cached_read: '1', cache_write: '1', output: '1' }, per_request_nano_usd: '0' });
        const s = await settle(h.json.hold_id, settleBody({ input_tokens: 1, output_tokens: 0 }, { retail: rate }));
        assert.strictEqual(s.json.charge_nano_usd, '1');
        // chargeFor would have returned 1 bit = 100 nano-USD equivalent
        const { chargeFor } = require('../server/ops/rating');
        const old = chargeFor({ id: 'old', provider: 'x', metric: 'token', unit_size: 1000000, unit_price_usd: 0.000001 }, 1, { bitsPerUsd: 100 });
        assert.strictEqual(old, 1); // 1 bit
        assert.strictEqual(Number(s.json.charge_nano_usd), 1); // 1 nano, 100x smaller in USD terms than 1 bit
    });

    await t.close();
    done();
})();
