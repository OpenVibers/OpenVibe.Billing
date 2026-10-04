'use strict';
/**
 * Renewal grace (plan T5 step 11, s2; money path): a credit renewal is one charge and one creator share per period
 * however often or concurrently the sweep runs; a renewal the subscriber cannot pay leaves the subscription past_due
 * (no access) and is retried under the SAME key until it is paid or the grace ends; a promo allowance never pays a
 * renewal; BILLING_RENEWAL_GRACE_DAYS=0 ends it at once; and a renewal reversed by a refund renews under a fresh key.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

const DAY = 86_400_000;

(async () => {
    const t = await boot({ env: { BILLING_RENEWAL_GRACE_DAYS: '3' } });
    const subs = require('../server/ops/subscriptions');
    const { post, money } = require('../server/ledger');
    console.log('renewal grace');

    const streamer = t.user(60);
    const sweep = async () => {
        const r = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.strictEqual(r.status, 200, r.text);
        return r.json;
    };
    const subscribe = async (u, bits) => {
        if (bits) await fund(t, u, bits);
        const r = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: u, streamer, source: 'credit' } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.subscription;
    };
    const row = async (id) => await subs.find(t.db, id);
    const renewals = async (id) => (await t.db.prepare("SELECT idempotency_key FROM transactions WHERE type = 'subscription' AND idempotency_key LIKE ? ORDER BY created_at").all(`renew:${id}:%`)).map((r) => r.idempotency_key);
    const changed = async (u) => (await t.db.prepare('SELECT event FROM outbox ORDER BY seq').all()).map((r) => JSON.parse(r.event))
        .filter((e) => e.event_type === 'billing.entitlement.changed' && e.subject.id.startsWith(`${u.id}:`)).map((e) => e.payload);
    const ent = async (u) => (await t.call('GET', `/api/v1/entitlements/${u.id}?streamer=${streamer.id}`)).json;
    const payable = async () => (await t.balances(streamer.id)).payable;

    const [a, b, c, d, e] = [t.user(61), t.user(62), t.user(63), t.user(64), t.user(65)];
    const subA = await subscribe(a, 998);   // can pay one renewal
    const subB = await subscribe(b, 499);   // fails, tops up during the grace
    const subC = await subscribe(c, 499);   // fails, never pays
    const subD = await subscribe(d, 499);   // fails, cancels during the grace
    const subE = await subscribe(e, 499);   // promo allowance only
    const P = subB.current_period_end;
    const graceUntil = (s) => new Date(Date.parse(s.current_period_end) + 3 * DAY).toISOString();
    let share = 5 * 349;

    await check('a promo allowance stays out of renewals', async () => {
        t.clock.offset = 32 * DAY;
        const g = await t.call('POST', '/api/v1/admin/promo/grant', { body: { subject: e, bits: 1000, service: 'openvibe.tools' }, cap: ['billing.ledger.admin'] });
        assert.strictEqual(g.status, 201, g.text);
        assert.strictEqual(await payable(), share);
    });

    await check('concurrent sweeps renew a paid-up subscription once: one charge, one creator share', async () => {
        const [s1, s2] = await Promise.all([sweep(), sweep()]);
        assert.deepStrictEqual([...s1.renewed, ...s2.renewed], [subA.id]);
        assert.deepStrictEqual(await renewals(subA.id), [`renew:${subA.id}:${subA.current_period_end}`]);
        share += 349;
        assert.strictEqual(await payable(), share);
        assert.strictEqual((await t.balances(a.id)).credit, 0);
        const replay = await subs.pay(t.ctx, { subscriber: a, streamer, source: 'credit', renewal: true, idempotencyKey: `renew:${subA.id}:${subA.current_period_end}`, actor: { principal: 'test' } });
        assert.strictEqual(replay.replay, true);
        assert.strictEqual(await payable(), share, 'a replayed renewal credits no second share');
        assert.deepStrictEqual((await sweep()).renewed, [], 'the renewed period is not due again');
    });

    await check('an unpaid renewal turns past_due with grace_until, grants no access and changes no money', async () => {
        for (const s of [subB, subC, subD, subE]) {
            const r = await row(s.id);
            assert.strictEqual(r.status, 'past_due', s.id);
            assert.strictEqual(r.grace_until, graceUntil(s));
            assert.ok(r.renewal_attempts >= 1); // the sweeps above retried it once or twice
            assert.strictEqual(r.auto_renew, true);
            assert.deepStrictEqual(await renewals(s.id), []);
        }
        const ev = (await changed(b)).filter((p) => p.reason === 'renewal_failed');
        assert.strictEqual(ev.length, 1, 'one renewal_failed event despite two concurrent sweeps');
        assert.deepStrictEqual([ev[0].active, ev[0].subscription.status, ev[0].grace_until, ev[0].renewal_period_end], [false, 'past_due', graceUntil(subB), P]);
        const en = await ent(b);
        assert.deepStrictEqual([en.active, en.subscription.status, en.grace_until], [false, 'past_due', graceUntil(subB)]);
        const got = (await t.call('GET', `/api/v1/subscriptions/${subB.id}`)).json;
        assert.strictEqual(got.subscription.grace_until, graceUntil(subB));
        assert.strictEqual(await payable(), share);
        const be = await t.balances(e.id);
        assert.deepStrictEqual([be.credit, be.promo_bits], [0, 1000], 'the promo allowance paid nothing');
        await t.assertReconciled('after failed renewals');
    });

    await check('each sweep in the grace retries the same charge; a retry that fails again emits nothing', async () => {
        t.clock.offset = 33 * DAY;
        const before = (await changed(b)).length;
        const attempts = (await row(subB.id)).renewal_attempts;
        const s = await sweep();
        assert.deepStrictEqual(s.renewed, []);
        assert.strictEqual((await row(subB.id)).renewal_attempts, attempts + 1);
        assert.strictEqual((await row(subB.id)).grace_until, graceUntil(subB), 'the grace is not extended by a retry');
        assert.strictEqual((await changed(b)).length, before);
        assert.strictEqual(await subs.renewalKey(t.db, await row(subB.id)), `renew:${subB.id}:${P}`);
    });

    await check('a top-up in the grace is picked up by the next sweep: active again, one charge, one share', async () => {
        await fund(t, b, 499);
        const c1 = await t.call('POST', `/api/v1/subscriptions/${subD.id}/cancel`, { cap: ['billing.subscription.manage'], body: {} });
        assert.strictEqual(c1.status, 200, c1.text);
        assert.strictEqual(c1.json.subscription.cancel_at_period_end, true);
        t.clock.offset = 33.5 * DAY;
        const [s1, s2] = await Promise.all([sweep(), sweep()]);
        assert.deepStrictEqual([...s1.renewed, ...s2.renewed], [subB.id]);
        assert.deepStrictEqual(await renewals(subB.id), [`renew:${subB.id}:${P}`], 'the retried key is the period key');
        share += 349;
        assert.strictEqual(await payable(), share);
        const r = await row(subB.id);
        assert.deepStrictEqual([r.status, r.grace_until, r.renewal_failed_at, r.renewal_attempts], ['active', null, null, 0]);
        const en = await ent(b);
        assert.deepStrictEqual([en.active, en.grace_until], [true, null]);
        assert.strictEqual((await changed(b)).at(-1).reason, 'renewed');
        assert.strictEqual((await row(subD.id)).status, 'canceled', 'cancelling in the grace ends it, uncharged');
        assert.deepStrictEqual(await renewals(subD.id), []);
    });

    await check('past grace_until the sweep ends it (grace_ended) and never charges it again', async () => {
        t.clock.offset = 35.1 * DAY;
        const s = await sweep();
        assert.deepStrictEqual(s.expired.sort(), [subC.id, subE.id].sort());
        for (const [u, sb] of [[c, subC], [e, subE]]) {
            assert.strictEqual((await row(sb.id)).status, 'expired');
            const last = (await changed(u)).at(-1);
            assert.deepStrictEqual([last.reason, last.active, last.subscription.status, last.renewal_period_end], ['grace_ended', false, 'expired', sb.current_period_end]);
        }
        await fund(t, c, 499);
        t.clock.offset = 36 * DAY;
        await sweep();
        assert.deepStrictEqual(await renewals(subC.id), [], 'an expired subscription is never charged');
        assert.strictEqual((await t.balances(c.id)).credit, 499);
        assert.deepStrictEqual(await renewals(subE.id), [], 'the promo allowance never paid a renewal');
        assert.strictEqual(await payable(), share);
        await t.assertReconciled('after the grace');
    });

    await check('with BILLING_RENEWAL_GRACE_DAYS=0 an unpaid renewal ends at once (renewal_insufficient_credit)', async () => {
        t.ctx.rates.renewalGraceDays = 0;
        const f = t.user(66);
        const subF = await subscribe(f, 499);
        t.clock.offset = 36 * DAY + 32 * DAY;
        await sweep();
        const r = await row(subF.id);
        assert.deepStrictEqual([r.status, r.grace_until, r.renewal_attempts], ['expired', null, 0]);
        assert.strictEqual((await changed(f)).at(-1).reason, 'renewal_insufficient_credit');
        t.ctx.rates.renewalGraceDays = 3;
    });

    await check('a renewal reversed by a refund renews under a fresh key, with a charge and a period', async () => {
        const g = t.user(67);
        const subG = await subscribe(g, 998);
        const PG = subG.current_period_end;
        t.clock.offset += 32 * DAY;
        await sweep();
        const [key0] = await renewals(subG.id);
        assert.strictEqual(key0, `renew:${subG.id}:${PG}`);
        const orig = await t.db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(key0);
        // A reversal that brings current_period_end back to PG (a credit-period refund, plan s3) with the subscription renewing.
        await money(t.db, async () => {
            await post(t.ctx, { type: 'refund', idempotencyKey: `test-refund:${orig.id}`, reversesTxn: orig.id, entries: [], actor: { principal: 'test' }, metadata: { cents: 0 } });
            await subs.revokeForTxn(t.ctx, orig.id, 'refund');
        });
        await t.db.prepare("UPDATE subscriptions SET status = 'active', auto_renew = 1 WHERE id = ?").run(subG.id);
        assert.strictEqual((await row(subG.id)).current_period_end, PG);
        assert.strictEqual(await subs.renewalKey(t.db, await row(subG.id)), `${key0}:1`);
        await fund(t, g, 499);
        const before = await payable();
        const [s1, s2] = await Promise.all([sweep(), sweep()]);
        assert.deepStrictEqual([...s1.renewed, ...s2.renewed], [subG.id]);
        assert.deepStrictEqual(await renewals(subG.id), [key0, `${key0}:1`]);
        assert.strictEqual(await payable(), before + 349, 'one charge, one share');
        assert.strictEqual((await t.balances(g.id)).credit, 0);
        assert.strictEqual((await ent(g)).active, true);
        await sweep();
        assert.strictEqual((await renewals(subG.id)).length, 2);
    });

    t.clock.offset = 0;
    await t.close();
    done();
})();
