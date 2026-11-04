'use strict';
/**
 * Credits: the prepaid USD balance for metered services (AI Exchange D1, D2; migrations/0011_inference_subledger.sql, ops/inference.js,
 * api/internal.js): holds, extends, settlements and releases in nano-USD, behind BILLING_CREDITS.
 * Sandbox grants are behind BILLING_CREDITS_SANDBOX. Nothing here touches chargeFor or Vibes bits.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const inference = require('../server/ops/credits');

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

    const alice = t.user(1);

    await check('sandbox grant creates an inference credit account and is marked test', async () => {
        const r = await grant({ subject: { type: 'user', id: alice.id }, project_id: PRJ, amount_nano_usd: '100000' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.amount_nano_usd, '100000');
        assert.strictEqual(r.json.balance_nano_usd, '100000');
        const txn = await t.db.prepare("SELECT * FROM transactions WHERE idempotency_key = ?").get(`credit:sandbox:${r.json.grant_id}`);
        assert.strictEqual(txn.test, 1);
        const entries = (await t.db.prepare('SELECT a.kind, a.owner_subject AS owner, a.currency, e.amount::text AS amount FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE e.txn_id = ?').all(txn.id));
        assert.deepStrictEqual(entries.map((e) => [e.kind, e.owner, e.currency, e.amount]).sort(),
            [['usd_credit', `${alice.id}:${PRJ}`, 'nano-usd', '100000'], ['usd_credit_sandbox', null, 'nano-usd', '-100000']]);
        await assertJournalBalances(t.db, 'after sandbox grant');
    });

    await check('create hold returns 201 with held, available and lease; 402 when balance is short', async () => {
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
        await grant({ subject: { type: 'user', id: bob.id }, project_id: PRJ, amount_nano_usd: '10000' });
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
        await grant({ subject: { type: 'user', id: carol.id }, project_id: PRJ, amount_nano_usd: '20000' });
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
        await grant({ subject: { type: 'user', id: dave.id }, project_id: PRJ, amount_nano_usd: '10000000' });
        const h = await create(holdBody(dave, 10000000));
        const s = await settle(h.json.hold_id, settleBody({ input_tokens: 1500000, cached_read_tokens: 2000000, cache_write_tokens: 1, output_tokens: 1 }));
        assert.strictEqual(s.status, 201, s.text);
        assert.strictEqual(s.json.charge_nano_usd, '2602');
        assert.strictEqual(s.json.released_nano_usd, '9997398');
    });

    await check('BYOK charges 0 regardless of usage', async () => {
        const erin = t.user(6);
        await grant({ subject: { type: 'user', id: erin.id }, project_id: PRJ, amount_nano_usd: '100000' });
        const h = await create(holdBody(erin, 50000));
        const s = await settle(h.json.hold_id, settleBody({ input_tokens: 1000000, output_tokens: 1000000 }, { byok: true }));
        assert.strictEqual(s.status, 201, s.text);
        assert.strictEqual(s.json.charge_nano_usd, '0');
        assert.strictEqual(s.json.released_nano_usd, '50000');
    });

    await check('settle replay charges once and releases the rest exactly once', async () => {
        const frank = t.user(7);
        await grant({ subject: { type: 'user', id: frank.id }, project_id: PRJ, amount_nano_usd: '100000' });
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
        await grant({ subject: { type: 'user', id: gina.id }, project_id: PRJ, amount_nano_usd: '100000' });
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
        await grant({ subject: { type: 'user', id: hank.id }, project_id: PRJ, amount_nano_usd: '100000' });
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
        await grant({ subject: { type: 'user', id: ivy.id }, project_id: PRJ, amount_nano_usd: '100000' });
        const h = await create(holdBody(ivy, 10000));
        t.clock.offset += 600 * 1000; // default lease is 300s; advance past it
        const out = await inference.sweepExpired(t.ctx);
        assert.ok(out.released >= 1, `expected at least 1 release, got ${out.released}; the hold answered ${h.status} ${JSON.stringify(h.json).slice(0, 300)}`);
        const row = await t.db.prepare('SELECT status FROM credit_holds WHERE id = ?').get(h.json.hold_id);
        assert.strictEqual(row.status, 'expired');
    });

    await check('100 concurrent holds on a balance that fits 7 succeed exactly 7 times and never go negative', async () => {
        const jack = t.user(11);
        await grant({ subject: { type: 'user', id: jack.id }, project_id: PRJ, amount_nano_usd: '70000' });
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

    await check('the journal balances after all inference operations', async () => {
        await assertJournalBalances(t.db, 'end of inference tests');
    });

    await check('the old chargeFor amplification for tiny usage does not affect the subledger', async () => {
        // Old chargeFor: 1 token at $0.000001/m (1 nano/token) with bitsPerUsd=100 rounds up to 1 bit = $0.01.
        // Subledger: 1 token at 1 nano/m = 1 nano-USD = $0.000000001, with no per-component minimum.
        const kate = t.user(12);
        await grant({ subject: { type: 'user', id: kate.id }, project_id: PRJ, amount_nano_usd: '1000' });
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
