'use strict';
/**
 * The credit-renewal grace (plan T5 step 11, s2; contracts 0.94.0's past_due on
 * billing.entitlement.changed): a renewal the subscriber cannot afford moves the subscription to
 * past_due with a grace_until window (reason renewal_failed) and keeps retrying the same period;
 * once the window passes unpaid the sweep expires it with reason grace_ended. The grace is opt-in
 * (BILLING_RENEWAL_GRACE_DAYS); subscriptions.test.js covers the default (expire at once).
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

const DAY = 86_400_000;

(async () => {
    const t = await boot({ env: { BILLING_RENEWAL_GRACE_DAYS: '3' } });
    console.log('subscriptions, renewal grace');

    const events = async (reason) => (await t.db.prepare('SELECT event FROM outbox ORDER BY seq').all())
        .map((r) => JSON.parse(r.event))
        .filter((e) => e.event_type === 'billing.entitlement.changed' && e.payload.reason === reason);

    await check('a renewal the credit cannot cover becomes past_due with a grace window, then renews once funded', async () => {
        const fan = t.user(61);
        const streamer = t.user(62);
        await fund(t, fan, 499);
        const r = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: fan, streamer, source: 'credit' } });
        assert.strictEqual(r.status, 201, r.text);
        const id = r.json.subscription.id;
        const periodEnd = r.json.subscription.current_period_end;

        t.clock.offset = 32 * DAY; // the period is over and the credit is spent
        const sw = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.deepStrictEqual(sw.json.past_due, [id]);

        const e = await t.call('GET', `/api/v1/entitlements/${fan.id}?streamer=${streamer.id}`);
        assert.strictEqual(e.json.active, false, 'past_due does not authorize');
        assert.strictEqual(e.json.subscription.status, 'past_due');
        assert.strictEqual(e.json.subscription.auto_renew, true, 'the grace keeps retrying the period');

        const [failed] = await events('renewal_failed');
        assert.ok(failed, 'a renewal_failed event is emitted');
        assert.strictEqual(failed.payload.renewal_period_end, periodEnd);
        assert.strictEqual(Date.parse(failed.payload.grace_until) - Date.parse(periodEnd), 3 * DAY);

        // A second sweep inside the window retries the same period and does not re-announce past_due.
        const sw2 = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.deepStrictEqual(sw2.json.past_due, []);
        assert.strictEqual((await events('renewal_failed')).length, 1);

        // Funding the credit lets the next sweep pay the same period and restore the entitlement.
        await fund(t, fan, 499);
        t.clock.offset = 33 * DAY;
        const sw3 = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.deepStrictEqual(sw3.json.renewed, [id]);
        const back = await t.call('GET', `/api/v1/entitlements/${fan.id}?streamer=${streamer.id}`);
        assert.strictEqual(back.json.active, true);
        assert.strictEqual(back.json.subscription.status, 'active');

        // A subscriber who never tops up: the window passes and the sweep ends it with grace_ended.
        t.clock.offset = 0;
        const f2 = t.user(63);
        await fund(t, f2, 499);
        const r2 = await t.call('POST', '/api/v1/subscriptions', { body: { subscriber: f2, streamer, source: 'credit' } });
        assert.strictEqual(r2.status, 201, r2.text);
        const id2 = r2.json.subscription.id;
        t.clock.offset = 32 * DAY;
        await t.call('POST', '/api/v1/admin/sweep', { key: null });
        t.clock.offset = 36 * DAY; // past 31 + 3
        const ended = await t.call('POST', '/api/v1/admin/sweep', { key: null });
        assert.ok(ended.json.expired.includes(id2));

        const e2 = await t.call('GET', `/api/v1/entitlements/${f2.id}?streamer=${streamer.id}`);
        assert.strictEqual(e2.json.subscription.status, 'expired');
        assert.strictEqual(e2.json.subscription.auto_renew, false, 'the end clears the retry');
        assert.strictEqual(e2.json.active, false);
        const [graceEnded] = await events('grace_ended');
        assert.ok(graceEnded, 'a grace_ended event is emitted');
        assert.ok(graceEnded.payload.renewal_period_end, 'grace_ended carries the period it was for');

        t.clock.offset = 0;
        await t.assertReconciled('after the renewal grace');
    });

    await t.close();
    done();
})();
