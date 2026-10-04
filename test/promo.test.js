'use strict';
/**
 * The promo ledger (migrations/0003_promo_ledger.sql, ops/promo.js; plan T5 step 5): free allowance lives in
 * promo_credit:<subject>, issued from promo_reserve by an admin grant and drawn down by consume() under the caller's key.
 * The core invariant: promo bits never become creator money — a subject holding only promo cannot transfer, cash out
 * or recycle, and no adjustment pairs a promo account with any other kind.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, fund, check, done } = require('./helpers/app');
const promo = require('../server/ops/promo');

const ADMIN = ['billing.ledger.admin'];
const PROMO = { kind: 'promo_credit', currency: 'vibes-bits' };
const RESERVE = { kind: 'promo_reserve', owner: null, currency: 'vibes-bits' };

/** A real user access token from the Network stub (authorization code + PKCE). */
async function userAccessToken(t) {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const code = t.network.authorize({ subject_id: t.user(900).id, challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), redirect_uri: 'http://x/cb' });
    const res = await fetch(`${t.network.url}/oauth/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://x/cb', client_id: 'billing', client_secret: 'shh' }).toString(),
    });
    return (await res.json()).access_token;
}

(async () => {
    console.log('promo ledger');
    const t = await boot();
    const grant = (body, opts = {}) => t.call('POST', '/api/v1/admin/promo/grant', { body, cap: ADMIN, ...opts });
    const promoBal = async (id) => (await t.balances(id)).promo_bits;
    const allowances = (id) => t.db.prepare('SELECT * FROM promo_allowances WHERE subject = ? ORDER BY id').all(id);
    const txns = async () => (await t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).n;

    await check('0003 widened accounts_kind_check (the name 0001 got) to the promo kinds', async () => {
        const c = await t.db.prepare("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_kind_check'").get();
        assert.ok(c, 'accounts_kind_check exists');
        for (const k of ['user_credit', 'creator_payable', 'fx_conversion', 'promo_credit', 'promo_reserve']) assert.ok(c.def.includes(`'${k}'`), `${k} in ${c.def}`);
        await assert.rejects(t.db.prepare("INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES ('promo_bogus', NULL, 'vibes-bits', 'x')").run());
    });

    const alice = t.user(1);
    const bob = t.user(2);
    await check('a grant books promo_reserve → promo_credit as one balanced transaction and opens a month window', async () => {
        const r = await grant({ subject: alice, bits: 300, service: 'openvibe.tools' });
        assert.strictEqual(r.status, 201, r.text);
        const a = r.json.allowance;
        assert.strictEqual(a.granted_bits, 300);
        assert.strictEqual(a.remaining_bits, 300);
        assert.strictEqual(a.reset_period, 'month');
        assert.strictEqual(a.service, 'openvibe.tools');
        const { window_start: ws, window_end: we } = a;
        assert.deepStrictEqual({ start: ws, end: we }, promo.windowOf('month', t.ctx.now()));
        const entries = r.json.transaction.entries.map((e) => [e.account.kind, e.account.owner, e.amount]).sort();
        assert.deepStrictEqual(entries, [['promo_credit', alice.id, 300], ['promo_reserve', null, -300]]);
        assert.strictEqual(r.json.transaction.metadata.promo, 'grant');
        assert.strictEqual(await promo.remaining(t.ctx, alice.id, 'openvibe.tools'), 300);
        assert.strictEqual(await promo.remaining(t.ctx, alice.id, 'media'), 0, 'a service-specific allowance is not spent elsewhere');
    });

    await check('a second grant in the same window sums granted_bits; a replayed Idempotency-Key moves nothing', async () => {
        const r = await grant({ subject: alice, bits: 200, service: 'openvibe.tools' }, { key: 'promo-grant-0001' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.allowance.granted_bits, 500);
        const before = await txns();
        const again = await grant({ subject: alice, bits: 200, service: 'openvibe.tools' }, { key: 'promo-grant-0001' });
        assert.ok([200, 201].includes(again.status), again.text);
        assert.strictEqual(await txns(), before);
        const rows = await allowances(alice.id);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(Number(rows[0].granted_bits), 500);
        assert.strictEqual(await promoBal(alice.id), 500);
        await t.assertReconciled('after grants');
    });

    await check('GET /balances/:subject reports promo_bits beside credit, payable and pending_payouts', async () => {
        const b = await t.balances(alice.id);
        assert.strictEqual(b.promo_bits, 500);
        assert.strictEqual(b.credit, 0);
        assert.strictEqual(b.payable, 0);
        assert.strictEqual(b.pending_payouts, 0);
        assert.strictEqual((await t.balances(bob.id)).promo_bits, 0);
    });

    await check('a subject holding only promo cannot transfer: billing.insufficient_funds, nothing moves', async () => {
        const before = await txns();
        const r = await t.call('POST', '/api/v1/transfers', { body: { from: alice, to: bob, amount: 1 } });
        assert.strictEqual(r.status, 409, r.text);
        assert.strictEqual(r.json.code, 'billing.insufficient_funds');
        assert.strictEqual(await txns(), before);
        const b = await t.balances(bob.id);
        assert.strictEqual(b.payable, 0);
        assert.strictEqual(await promoBal(alice.id), 500);
    });

    await check('a subject holding only promo cannot cash out or recycle', async () => {
        const c = await t.call('POST', '/api/v1/cashouts', { body: { subject: alice, amount: 500, payout_method: { type: 'paypal', address: 'a@example.com' } } });
        assert.strictEqual(c.status, 409, c.text);
        assert.strictEqual(c.json.code, 'billing.insufficient_funds');
        const r = await t.call('POST', '/api/v1/recycle', { body: { subject: alice, amount: 100 } });
        assert.strictEqual(r.status, 409, r.text);
        assert.strictEqual(await promoBal(alice.id), 500);
    });

    await check('recycle still works; promo → payable or credit is impossible, even by an admin adjustment', async () => {
        await fund(t, bob, 1000);
        const tip = await t.call('POST', '/api/v1/transfers', { body: { from: bob, to: alice, amount: 400 } });
        assert.strictEqual(tip.status, 201, tip.text);
        const rec = await t.call('POST', '/api/v1/recycle', { body: { subject: alice, amount: 100 } });
        assert.strictEqual(rec.status, 201, rec.text);
        const b = await t.balances(alice.id);
        assert.deepStrictEqual([b.credit, b.payable, b.promo_bits], [100, 300, 500], 'recycle touched payable and credit only');
        for (const to of [{ kind: 'creator_payable', owner: alice.id, currency: 'vibes-bits' }, { kind: 'user_credit', owner: alice.id, currency: 'vibes-bits' }]) {
            const adj = await t.call('POST', '/api/v1/admin/adjustments', { cap: ADMIN, body: { from: { ...PROMO, owner: alice.id }, to, amount: 1, reason: 'try' } });
            assert.strictEqual(adj.status, 422, adj.text);
            assert.strictEqual(adj.json.code, 'billing.promo_isolated');
        }
        const into = await t.call('POST', '/api/v1/admin/adjustments', { cap: ADMIN, body: { from: { kind: 'platform_revenue', currency: 'vibes-bits' }, to: { ...PROMO, owner: alice.id }, amount: 1, reason: 'try' } });
        assert.strictEqual(into.json.code, 'billing.promo_isolated');
        const fix = await t.call('POST', '/api/v1/admin/adjustments', { cap: ADMIN, body: { from: { ...PROMO, owner: alice.id }, to: RESERVE, amount: 10, reason: 'over-granted' } });
        assert.strictEqual(fix.status, 201, fix.text);
        assert.strictEqual(await promoBal(alice.id), 490);
        assert.strictEqual(await promo.remaining(t.ctx, alice.id, 'openvibe.tools'), 490, 'remaining never exceeds the authoritative balance');
        await t.assertReconciled('after recycle and promo correction');
    });

    await check('consume() draws the allowance down under the caller\'s key; a retry under the same key consumes nothing more', async () => {
        const out = await promo.consume(t.ctx, { subject: alice.id, service: 'openvibe.tools', bits: 90, idempotencyKey: 'usage:reading:1' });
        assert.strictEqual(out.bits, 90);
        assert.strictEqual(out.replay, false);
        const after = { bal: await promoBal(alice.id), used: Number((await allowances(alice.id))[0].used_bits), n: await txns() };
        assert.deepStrictEqual([after.bal, after.used], [400, 90]);
        const retry = await promo.consume(t.ctx, { subject: alice.id, service: 'openvibe.tools', bits: 90, idempotencyKey: 'usage:reading:1' });
        assert.strictEqual(retry.replay, true);
        assert.strictEqual(retry.bits, 90);
        assert.strictEqual(retry.txn.id, out.txn.id);
        assert.deepStrictEqual({ bal: await promoBal(alice.id), used: Number((await allowances(alice.id))[0].used_bits), n: await txns() }, after);
        const entries = out.txn.entries.map((e) => [e.kind, e.owner, e.amount]).sort();
        assert.deepStrictEqual(entries, [['promo_credit', alice.id, -90], ['promo_reserve', null, 90]]);
        await assert.rejects(promo.consume(t.ctx, { subject: alice.id, service: 'openvibe.tools', bits: 1 }), (e) => e.code === 'billing.invalid_input');
        for (const other of [{ subject: bob.id, service: 'openvibe.tools' }, { subject: alice.id, service: 'media' }]) {
            await assert.rejects(promo.consume(t.ctx, { ...other, bits: 90, idempotencyKey: 'usage:reading:1' }), (e) => e.code === 'billing.promo_key_reused');
        }
    });

    await check('consume() is capped by what is left and by the service; a "*" grant serves any service', async () => {
        assert.strictEqual((await promo.consume(t.ctx, { subject: alice.id, service: 'media', bits: 5, idempotencyKey: 'usage:reading:2' })).bits, 0);
        const all = await promo.consume(t.ctx, { subject: alice.id, service: 'openvibe.tools', bits: 10_000, idempotencyKey: 'usage:reading:3' });
        assert.strictEqual(all.bits, 400);
        assert.strictEqual(await promoBal(alice.id), 0);
        assert.strictEqual((await grant({ subject: bob, bits: 50 })).status, 201);
        assert.strictEqual((await promo.consume(t.ctx, { subject: bob.id, service: 'media', bits: 20, idempotencyKey: 'usage:reading:4' })).bits, 20);
        assert.strictEqual(await promo.remaining(t.ctx, bob.id, 'anything'), 30);
        await t.assertReconciled('after consumption');
    });

    await check('a window that ends lapses: its unused bits return to promo_reserve once', async () => {
        const carol = t.user(3);
        assert.strictEqual((await grant({ subject: carol, bits: 70, period: 'day' })).status, 201);
        await promo.consume(t.ctx, { subject: carol.id, service: 'media', bits: 20, idempotencyKey: 'usage:reading:5' });
        t.clock.offset += 86_400_000;
        assert.strictEqual(await promo.remaining(t.ctx, carol.id, 'media'), 0);
        assert.strictEqual(await promoBal(carol.id), 0, 'GET /balances does not count an ended window before it lapses');
        assert.strictEqual((await promo.consume(t.ctx, { subject: carol.id, service: 'media', bits: 5, idempotencyKey: 'usage:reading:6' })).bits, 0);
        const [row] = await allowances(carol.id);
        assert.deepStrictEqual([Number(row.used_bits), Number(row.expired_bits)], [20, 50]);
        assert.strictEqual(await promoBal(carol.id), 0);
        const n = await txns();
        await t.ctx.db.tx(() => promo.lapse(t.ctx, carol.id));
        assert.strictEqual(await txns(), n, 'a lapsed window lapses once');
        const fresh = await grant({ subject: carol, bits: 15, period: 'day' });
        assert.strictEqual(fresh.json.allowance.remaining_bits, 15, 'the next window starts afresh');
        t.clock.offset = 0;
        const r = await t.assertReconciled('after lapse');
        assert.ok(r.checks.find((c) => c.id === 'promo.isolated').ok);
    });

    await check('period "none" is one window that never ends (window_end 9999-12-31T23:59:59.999Z) and never lapses', async () => {
        const dave = t.user(4);
        const r = await grant({ subject: dave, bits: 25, period: 'none' });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual([r.json.allowance.window_start, r.json.allowance.window_end], ['1970-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']);
        t.clock.offset += 400 * 86_400_000;
        assert.strictEqual(await promoBal(dave.id), 25);
        assert.strictEqual((await promo.consume(t.ctx, { subject: dave.id, service: 'media', bits: 5, idempotencyKey: 'usage:reading:7' })).bits, 5);
        assert.strictEqual((await grant({ subject: dave, bits: 10, period: 'none' })).json.allowance.remaining_bits, 30, 'a second grant tops up the same window');
        t.clock.offset = 0;
        await t.assertReconciled('after a period "none" grant');
    });

    await check('a grant needs billing.ledger.admin and a valid body: no token 401, a user token 401, another capability 403', async () => {
        assert.strictEqual((await grant({ subject: alice, bits: 1 }, { token: null })).status, 401);
        assert.strictEqual((await grant({ subject: alice, bits: 1 }, { token: await userAccessToken(t) })).status, 401);
        const denied = await grant({ subject: alice, bits: 1 }, { cap: ['billing.balance.read', 'billing.transfer.create'] });
        assert.strictEqual(denied.status, 403, denied.text);
        for (const body of [{ subject: alice, bits: 0 }, { subject: alice, bits: 1.5 }, { subject: alice, bits: 1, period: 'week' }, { subject: 'gst_x', bits: 1 }, { bits: 1 }]) {
            const r = await grant(body);
            assert.strictEqual(r.status, 422, `${JSON.stringify(body)} → ${r.status} ${r.text}`);
        }
    });

    await check('a grant is refused while the economy is frozen', async () => {
        assert.strictEqual((await t.call('POST', '/api/v1/admin/freeze', { cap: ADMIN, key: null, body: { on: true, reason: 'test' } })).status, 200);
        const r = await grant({ subject: alice, bits: 1 });
        assert.strictEqual(r.status, 503, r.text);
        assert.strictEqual((await t.call('POST', '/api/v1/admin/freeze', { cap: ADMIN, key: null, body: { on: false } })).status, 200);
    });

    await t.close();
    done();
})();
