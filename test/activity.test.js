'use strict';
/**
 * GET /api/me/activity (D12, Network's /wallet): the signed-in person's own Balance and Vibes movements, newest
 * first, with plain labels and exact integer amounts. A from-Balance Vibes purchase has two rows sharing one id.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const { post } = require('../server/ledger');
const { entry, A } = require('../server/ops/common');
const { A_INF } = require('../server/ops/credits');
const balances = require('../server/ops/balance');
const transfers = require('../server/ops/transfers');

const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const MARKET = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPZ';
const key = (p) => `${p}:${crypto.randomBytes(8).toString('hex')}`;

(async () => {
    console.log('activity');
    const t = await boot({ env: { BILLING_CREDITS: '1', BILLING_VIBES_FROM_BALANCE: '1' } });
    const alice = t.user(1, 'alice');
    const bob = t.user(2, 'bob');
    t.network.addMembership(PRJ, alice.id, 'owner', false, 'Studio');
    const aliceToken = t.network.signUser({ subject_id: alice.id, username: 'alice' });
    const bobToken = t.network.signUser({ subject_id: bob.id, username: 'bob' });

    const fund = (amount) => post(t.ctx, {
        type: 'credit', idempotencyKey: key('fund'), test: true, actor: { type: 'service', id: 'billing' }, toSubject: alice.id,
        provider: 'stripe',
        entries: [entry(A_INF.clearing('stripe'), -BigInt(amount)), entry(A_INF.credit(alice.id, null), BigInt(amount))],
        metadata: { credit: 'topup', amount_nano_usd: String(amount) },
    });
    const get = async (token, q = '') => {
        const r = await fetch(`${t.base}/api/me/activity${q}`, { headers: { Authorization: `Bearer ${token}` } });
        const text = await r.text();
        return { status: r.status, text, body: text ? JSON.parse(text) : null };
    };

    const topup = await fund('3000000000');
    const moved = await balances.transfer(t.ctx, { subject: alice.id, toProjectId: PRJ, amountNanoUsd: '300000000', idempotencyKey: key('tr') });
    const got = await balances.buyVibes(t.ctx, { subject: alice.id, vibes: 100, idempotencyKey: key('vb') });
    const tip = await transfers.create(t.ctx, { from: alice.id, to: bob.id, amount: 25, idempotencyKey: key('tip'), actor: { type: 'service', id: 'tips' } });
    await transfers.refund(t.ctx, { txnId: tip.txn.id, idempotencyKey: key('refund') });
    const hold = await require('../server/ops/credits').createHold(t.ctx, {
        subject: { type: 'user', id: alice.id }, max_nano_usd: '100000', rate_version: 'rc-activity',
        request_fingerprint: 'fp-activity', idempotency_key: key('hold'),
    });
    await require('../server/ops/credits').settleHold(t.ctx, {
        hold_id: hold.hold.hold_id, idempotency_key: key('settle'),
        usage: { input_tokens: 1000, cached_read_tokens: 0, cache_write_tokens: 0, output_tokens: 1000 },
        retail: { version: 'rc-activity', nano_usd_per_m: { input: '1000', cached_read: '0', cache_write: '0', output: '3000' }, per_request_nano_usd: '100' },
        supply_cost_nano_usd: '0', byok: false,
        attempts: [{ deployment_id: 'own:qwen/qwen3-4b:q4_k_m@3f2a1c9', provider_access: 'OWN_DEPLOYMENT', started_at: new Date().toISOString(), ended_at: new Date().toISOString() }],
    });
    const paid = await post(t.ctx, {
        type: 'purchase', idempotencyKey: key('app'), test: true, actor: { type: 'service', id: 'billing' }, toSubject: alice.id,
        entries: [entry(A.credit(alice.id), -50), entry(A.credit(MARKET), 50)],
        metadata: { vibes_charge_id: 'vch_01JAB2C3D4E5F6G7H8J9K0MNPQ', app_name: 'Sticker Shop', description: 'Neon cats' },
    });

    await check('the caller\'s own rows carry exact amounts and plain labels', async () => {
        const cors = await fetch(`${t.base}/api/me/activity`, { headers: { Authorization: `Bearer ${aliceToken}`, Origin: 'https://openvibe.network' } });
        assert.strictEqual(cors.headers.get('access-control-allow-origin'), 'https://openvibe.network');
        assert.strictEqual(cors.headers.get('cache-control'), 'private, no-store');
        const r = await get(aliceToken);
        assert.strictEqual(r.status, 200, r.text);
        const rows = r.body.activity;
        const byLabel = (l) => rows.filter((x) => x.label === l);
        assert.strictEqual(byLabel('for adding money to your Balance')[0].detail, 'Stripe');
        assert.strictEqual(byLabel('for adding money to your Balance')[0].amount, '3000000000');
        assert.strictEqual(byLabel('for moving money to Studio')[0].amount, '-300000000');
        assert.strictEqual(byLabel('for a tip to @bob')[0].amount, -25);
        assert.deepStrictEqual(byLabel('for a tip to @bob')[0].subject, { name: '@bob', url: 'https://openvibe.live/@bob' });
        assert.deepStrictEqual(byLabel('for moving money to Studio')[0].subject && byLabel('for moving money to Studio')[0].subject.name, 'Studio');
        assert.strictEqual(byLabel('for a refund')[0].reason_key, 'refund');
        assert.strictEqual(byLabel('for a refund')[0].amount, 25);
        assert.strictEqual(byLabel('for paying Sticker Shop')[0].amount, -50);
        assert.strictEqual(byLabel('for paying Sticker Shop')[0].detail, 'Neon cats');
        const ai = byLabel('for AI usage')[0];
        assert.strictEqual(ai.kind, 'balance');
        assert.ok(ai.detail.includes('qwen/qwen3-4b:q4_k_m@3f2a1c9'), ai.detail);
        assert.ok(ai.detail.includes('1 request'), ai.detail);
        assert.strictEqual(ai.amount, '-104'); // 1000 input @ 1000/m = 1; 1000 output @ 3000/m = 3; +100 per request
        assert.ok(rows.every((x) => x.kind === 'balance' || x.kind === 'vibes'));
        assert.strictEqual(rows.length, 8);
    });

    await check('Get Vibes with Balance has two rows sharing the transaction id', async () => {
        const r = await get(aliceToken);
        const pair = r.body.activity.filter((x) => x.id === got.transaction_id);
        assert.strictEqual(pair.length, 2, JSON.stringify(pair));
        assert.deepStrictEqual(pair.map((x) => x.kind).sort(), ['balance', 'vibes']);
        const bal = pair.find((x) => x.kind === 'balance');
        const vib = pair.find((x) => x.kind === 'vibes');
        assert.strictEqual(bal.label, 'for buying Vibes with your Balance');
        assert.strictEqual(vib.label, 'for buying Vibes with your Balance');
        assert.strictEqual(bal.amount, '-1000000000');
        assert.strictEqual(vib.amount, 100);
        assert.ok(pair.every((x) => x.id === got.transaction_id));
    });

    await check('only the caller\'s rows, another token sees none of them', async () => {
        const mine = await get(aliceToken);
        const theirs = await get(bobToken);
        assert.strictEqual(theirs.status, 200, theirs.text);
        const myIds = new Set(mine.body.activity.map((x) => x.id));
        for (const id of [topup.txn.id, moved.transaction_id, got.transaction_id, tip.txn.id, paid.txn.id]) assert.ok(myIds.has(id), id);
        assert.ok(!theirs.body.activity.some((x) => myIds.has(x.id)), 'bob sees none of alice\'s transactions');
        assert.ok(!theirs.text.includes(alice.id), 'no other person\'s subject id');
        assert.ok(!mine.text.includes(bob.id), 'a tip names the creator by public name only');
        assert.ok(!/usr_[0-9A-HJKMNP-TV-Z]{26}/.test(mine.text), 'no subject ids in the activity text');
    });

    await check('pagination uses the last transaction id as the cursor', async () => {
        const first = await get(aliceToken, '?limit=2');
        assert.strictEqual(first.status, 200, first.text);
        assert.ok(first.body.activity.length <= 4);
        assert.ok(first.body.next_before);
        const next = await get(aliceToken, `?limit=2&before=${encodeURIComponent(first.body.next_before)}`);
        assert.strictEqual(next.status, 200, next.text);
        const firstIds = new Set(first.body.activity.map((x) => x.id));
        assert.ok(!next.body.activity.some((x) => firstIds.has(x.id)), 'pages do not overlap');
        assert.strictEqual((await get(aliceToken, '?before=txn_nope')).status, 422);
        assert.strictEqual((await fetch(`${t.base}/api/me/activity`)).status, 401);
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
