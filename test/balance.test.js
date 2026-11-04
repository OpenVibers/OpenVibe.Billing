'use strict';
/**
 * Balance (D12): personal and project accounts, GET /api/me/balance (and the /api/me/credits alias), transfers
 * between them, and getting Vibes with Balance. Money is integer nano-USD; every write is idempotent and every
 * journal stays balanced.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const inference = require('../server/ops/credits');
const { post } = require('../server/ledger');
const { validate } = require('openvibe-contracts');

const INF = ['billing.credit.hold.create', 'billing.credit.hold.settle', 'billing.credit.hold.release'];
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRJ2 = 'prj_01JAB2C3D4E5F6G7H8J9K0MNP2';
const PRJ3 = 'prj_01JAB2C3D4E5F6G7H8J9K0MNP3';
const PRJ4 = 'prj_01JAB2C3D4E5F6G7H8J9K0MNP4';
const prjBody = (subject, max, over = {}) => ({
    idempotency_key: `hold:${crypto.randomBytes(8).toString('hex')}`,
    subject: { type: 'user', id: subject.id },
    max_nano_usd: String(max),
    rate_version: 'rc-v1',
    request_fingerprint: crypto.randomBytes(8).toString('hex'),
    ...over,
});

async function assertJournalBalances(db, label) {
    const rows = await db.prepare(`SELECT a.currency, SUM(e.amount)::text AS total FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id GROUP BY a.currency`).all();
    for (const r of rows) assert.strictEqual(String(r.total), '0', `journal not balanced for ${r.currency} ${label}: ${r.total}`);
}

(async () => {
    console.log('Balance');
    const t = await boot({ env: { BILLING_CREDITS: '1', BILLING_VIBES_FROM_BALANCE: '1' } });
    // A real top-up booked the way checkout funding books one: money arrives at a provider and lands in an account.
    const fund = (subjectId, projectId, amount) => post(t.ctx, {
        type: 'credit', idempotencyKey: `test:fund:${crypto.randomBytes(8).toString('hex')}`, test: true,
        actor: { type: 'service', id: 'billing' }, toSubject: subjectId,
        entries: [
            { kind: 'provider_clearing', owner: 'stripe', currency: 'nano-usd', amount: -BigInt(amount) },
            { ...inference.A_INF.credit(subjectId, projectId), amount: BigInt(amount) },
        ],
        metadata: { credit: 'test_top_up' },
    });
    const balance = (subjectId, projectId) => inference.A_INF.credit(subjectId, projectId);
    const create = (body, opts = {}) => t.call('POST', '/internal/credits/holds', { body, cap: INF, sub: 'svc:ai', ...opts });
    const alice = t.user(1);
    const token = t.network.signUser({ subject_id: alice.id, username: 'alice' });
    const who = (u) => t.network.signUser({ subject_id: u.id, username: 'u' });

    await check('a personal hold spends user:<usr_id>; a project hold spends project:<prj_id>', async () => {
        await fund(alice.id, null, '100000');
        await fund(null, PRJ, '200000');
        const personal = await create(prjBody(alice, '40000', { project_id: undefined }));
        assert.strictEqual(personal.status, 201, personal.text);
        assert.strictEqual(personal.json.project_id, null);
        const row = await t.db.prepare('SELECT subject_type, project_id, account_id FROM credit_holds WHERE id = ?').get(personal.json.hold_id);
        assert.strictEqual(row.subject_type, 'user');
        assert.strictEqual(row.project_id, null);
        const acct = await t.db.prepare('SELECT owner_subject FROM accounts WHERE id = ?').get(row.account_id);
        assert.strictEqual(acct.owner_subject, `user:${alice.id}`);
        assert.strictEqual(await t.db.prepare('SELECT balance::text AS b FROM account_balances WHERE account_id = ?').get(row.account_id).then((x) => x.b), '100000');

        const bob = t.user(2);
        const project = await create(prjBody(bob, '50000', { project_id: PRJ }));
        assert.strictEqual(project.status, 201, project.text);
        const prow = await t.db.prepare('SELECT account_id FROM credit_holds WHERE id = ?').get(project.json.hold_id);
        const pacct = await t.db.prepare('SELECT owner_subject FROM accounts WHERE id = ?').get(prow.account_id);
        assert.strictEqual(pacct.owner_subject, `project:${PRJ}`);
        assert.strictEqual((await t.db.prepare('SELECT balance::text AS b FROM account_balances WHERE account_id = ?').get(prow.account_id)).b, '200000');
        await assertJournalBalances(t.db, 'after holds');
    });

    await check('GET /api/me/balance has the contract shape and only the projects the person administers', async () => {
        t.network.addMembership(PRJ, alice.id, 'admin');
        t.network.addMembership(PRJ2, alice.id, 'owner');
        t.network.addMembership(PRJ3, alice.id, 'viewer');
        t.network.addMembership(PRJ4, alice.id, 'owner', true);
        const r = await fetch(`${t.base}/api/me/balance`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://openvibe.network' } });
        assert.strictEqual(r.status, 200, await r.clone().text());
        assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://openvibe.network');
        const doc = await r.json();
        const personalValid = validate('billing.balance@1', doc.personal);
        assert.ok(personalValid.valid, JSON.stringify(personalValid.errors));
        for (const p of doc.projects) {
            const valid = validate('billing.balance@1', p);
            assert.ok(valid.valid, JSON.stringify(valid.errors));
        }
        assert.deepStrictEqual(doc.personal.owner, { type: 'user', id: alice.id });
        assert.strictEqual(typeof doc.personal.balance_nano_usd, 'string');
        assert.deepStrictEqual(doc.projects.map((p) => p.owner.id), [PRJ, PRJ2].sort());
        assert.ok(doc.projects.every((p) => p.owner.type === 'project' && typeof p.available_nano_usd === 'string'));
        const alias = await (await fetch(`${t.base}/api/me/credits`, { headers: { Authorization: `Bearer ${token}` } })).json();
        assert.deepStrictEqual(alias, doc, '/api/me/credits is the same answer');
        assert.strictEqual((await fetch(`${t.base}/api/me/balance`)).status, 401);
        await assertJournalBalances(t.db, 'after reads');
    });

    await check('a transfer is atomic and idempotent, and refuses a short Balance or a non-admin', async () => {
        const dana = t.user(3);
        t.network.addMembership(PRJ, dana.id, 'admin');
        await fund(dana.id, null, '100000');
        const post1 = (body, tok = who(dana)) => t.call('POST', '/api/me/balance/transfers', { body, token: tok });
        const key = `tr:${crypto.randomBytes(8).toString('hex')}`;
        const bad = await post1({ to_project_id: 'nope', amount_nano_usd: 5, idempotency_key: 'short' });
        assert.strictEqual(bad.status, 422, bad.text);
        assert.strictEqual(bad.json.code, 'billing.invalid_request');
        const first = await post1({ to_project_id: PRJ, amount_nano_usd: '30000', idempotency_key: key });
        assert.strictEqual(first.status, 201, first.text);
        assert.strictEqual(first.json.from.balance_nano_usd, '70000');
        assert.strictEqual(first.json.to.balance_nano_usd, String(200000 + 30000));
        const replay = await post1({ to_project_id: PRJ, amount_nano_usd: '30000', idempotency_key: key });
        assert.strictEqual(replay.status, 200, replay.text);
        assert.strictEqual(replay.json.transfer_id, first.json.transfer_id);
        assert.strictEqual(replay.json.from.balance_nano_usd, '70000', 'the replay moves nothing');
        const one = await t.db.prepare('SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = ?').get(`balance:transfer:${key}`);
        assert.strictEqual(one.n, 1);
        const reused = await post1({ to_project_id: PRJ, amount_nano_usd: '1000', idempotency_key: key });
        assert.strictEqual(reused.status, 409, reused.text);
        const short = await post1({ to_project_id: PRJ, amount_nano_usd: '999999', idempotency_key: `tr:${crypto.randomBytes(8).toString('hex')}` });
        assert.strictEqual(short.status, 402, short.text);
        const eve = t.user(4);
        t.network.addMembership(PRJ3, eve.id, 'viewer');
        await fund(eve.id, null, '100000');
        const denied = await post1({ to_project_id: PRJ3, amount_nano_usd: '1000', idempotency_key: `tr:${crypto.randomBytes(8).toString('hex')}` }, who(eve));
        assert.strictEqual(denied.status, 403, denied.text);
        assert.strictEqual(denied.json.code, 'billing.not_project_admin');
        // Two different keys for all the money: exactly one wins, the other is short, never below zero.
        const d2 = t.user(5);
        t.network.addMembership(PRJ2, d2.id, 'owner');
        await fund(d2.id, null, '10000');
        const results = await Promise.all([
            post1({ to_project_id: PRJ2, amount_nano_usd: '10000', idempotency_key: `tr:${crypto.randomBytes(8).toString('hex')}` }, who(d2)),
            post1({ to_project_id: PRJ2, amount_nano_usd: '10000', idempotency_key: `tr:${crypto.randomBytes(8).toString('hex')}` }, who(d2)),
        ]);
        assert.strictEqual(results.filter((x) => x.status === 201).length, 1, JSON.stringify(results.map((x) => [x.status, x.json && x.json.code])));
        const neg = await t.db.prepare("SELECT COUNT(*)::int AS n FROM account_balances b JOIN accounts a ON a.id = b.account_id WHERE a.kind IN ('usd_credit', 'usd_credit_sandbox') AND b.balance < 0").get();
        assert.strictEqual(neg.n, 0, 'no account below zero');
        // The same key at the same moment: one transfer, both answers the same id.
        const gina = t.user(8);
        t.network.addMembership(PRJ, gina.id, 'owner');
        await fund(gina.id, null, '5000');
        const sameKey = `tr:${crypto.randomBytes(8).toString('hex')}`;
        const pair = await Promise.all([
            post1({ to_project_id: PRJ, amount_nano_usd: '1000', idempotency_key: sameKey }, who(gina)),
            post1({ to_project_id: PRJ, amount_nano_usd: '1000', idempotency_key: sameKey }, who(gina)),
        ]);
        assert.deepStrictEqual(pair.map((x) => x.status).sort(), [200, 201], JSON.stringify(pair.map((x) => [x.status, x.json])));
        assert.strictEqual(pair[0].json.transfer_id, pair[1].json.transfer_id);
        assert.strictEqual((await t.db.prepare('SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = ?').get(`balance:transfer:${sameKey}`)).n, 1);
        assert.strictEqual((await t.db.prepare('SELECT balance::text AS b FROM account_balances b JOIN accounts a ON a.id = b.account_id WHERE a.owner_subject = ?').get(`user:${gina.id}`)).b, '4000');
        await assertJournalBalances(t.db, 'after transfers');
    });

    await check('Vibes from Balance books exactly: USD to platform_revenue, Vibes minted as a pack', async () => {
        const fred = t.user(6);
        await fund(fred.id, null, '1000000000');
        const buy = (body, tok = who(fred)) => t.call('POST', '/api/me/vibes/from-balance', { body, token: tok });
        const key = `vb:${crypto.randomBytes(8).toString('hex')}`;
        const r = await buy({ vibes: 100, idempotency_key: key });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.price_nano_usd, '1000000000', '100 Vibes at 100 per USD = $1 exactly');
        assert.strictEqual(r.json.balance.balance_nano_usd, '0');
        assert.strictEqual(r.json.vibes_credit, 100);
        const txn = await t.db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(`balance:vibes:${key}`);
        const entries = await t.db.prepare(`SELECT a.kind, a.owner_subject AS owner, a.currency, e.amount::text AS amount FROM ledger_entries e
            JOIN accounts a ON a.id = e.account_id WHERE e.txn_id = ? ORDER BY a.currency, a.kind`).all(txn.id);
        assert.deepStrictEqual(entries.map((e) => [e.kind, e.owner, e.currency, e.amount]).sort(), [
            ['fx_conversion', null, 'vibes-bits', '-100'],
            ['user_credit', fred.id, 'vibes-bits', '100'],
            ['platform_revenue', null, 'nano-usd', '1000000000'],
            ['usd_credit', `user:${fred.id}`, 'nano-usd', '-1000000000'],
        ].sort());
        const replay = await buy({ vibes: 100, idempotency_key: key });
        assert.strictEqual(replay.status, 200, replay.text);
        assert.strictEqual(replay.json.purchase_id, r.json.purchase_id);
        const again = await t.db.prepare("SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = ?").get(`balance:vibes:${key}`);
        assert.strictEqual(again.n, 1);
        const different = await buy({ vibes: 200, idempotency_key: key });
        assert.strictEqual(different.status, 409, different.text);
        const short = await buy({ vibes: 100, idempotency_key: `vb:${crypto.randomBytes(8).toString('hex')}` });
        assert.strictEqual(short.status, 402, short.text);
        await assertJournalBalances(t.db, 'after Vibes from Balance');
    });

    await check('billing.vibes is served by the D11 store with its danger keys', async () => {
        const r = await t.call('GET', '/internal/config/billing.vibes', { cap: ['billing.config.manage'] });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.namespace, 'billing.vibes');
        for (const k of ['vibes_pay', 'max_charge_vibes', 'daily_app_spend_vibes_per_person', 'from_balance']) assert.ok(r.json.schema.properties[k], `${k} is in the schema`);
        assert.strictEqual(r.json.schema.properties.vibes_pay['x-danger'], true);
        assert.strictEqual(r.json.schema.properties.from_balance['x-danger'], true);
    });

    await check('the disabled switch refuses Get Vibes with Balance', async () => {
        const off = await boot({ env: { BILLING_CREDITS: '1' } });
        try {
            const u = off.user(7);
            const r = await off.call('POST', '/api/me/vibes/from-balance', { body: { vibes: 100, idempotency_key: 'vb:off:0001' }, token: off.network.signUser({ subject_id: u.id, username: 'off' }) });
            assert.strictEqual(r.status, 404, r.text);
            assert.strictEqual(r.json.code, 'billing.vibes_from_balance_disabled');
        } finally { await off.close(); }
        await assertJournalBalances(t.db, 'at the end');
    });

    done();
})().catch((e) => { console.error(e); process.exit(1); });
