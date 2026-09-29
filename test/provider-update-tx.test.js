'use strict';
/**
 * A provider 'update' plan (a state change, no money: linking a Stripe subscription, ending one)
 * is applied inside the event's own transaction — the same one that stamps processed_at. Its
 * apply() is async (providers/stripe.js), so it must be awaited: a dropped promise ran on the pool
 * after the transaction had committed, so a failed update still marked the event processed, told
 * the provider success, left the update half-done and raised an unhandled rejection.
 *
 * The 'flaky' adapter below is injected through app.locals.adapters (what createApp handed the
 * webhook router) so the failure is deterministic instead of needing a real provider outage.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    console.log('provider update plans run inside the event transaction');

    let applies = 0;
    let outcome = 'ok';
    t.app.locals.adapters.flaky = {
        name: 'flaky',
        enabled: true,
        verify: async () => ({ ok: true }),
        parse: (req) => {
            const p = JSON.parse(req.rawBody.toString('utf8'));
            return { eventId: p.id, type: p.type, payload: p };
        },
        interpret: async () => ({
            effect: 'update',
            reason: 'flaky update',
            // A real plan's apply does a write (mergeMetadata, subscriptions.setStatus) and can fail.
            apply: async () => { applies += 1; if (outcome !== 'ok') throw new Error(`provider update failed: ${outcome}`); },
        }),
    };

    const deliver = async (id) => {
        const res = await fetch(`${t.base}/webhooks/flaky`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, type: 'flaky.updated' }) });
        const text = await res.text();
        return { status: res.status, text, json: JSON.parse(text) };
    };
    const stored = async (id) => await t.db.prepare('SELECT * FROM provider_events WHERE provider = ? AND provider_event_id = ?').get('flaky', id);

    // A dropped promise rejects with nobody listening: Node would abort the process before the
    // assertions below could say why. Hold the rejection here so this file reports it as a failure.
    const dropped = [];
    const onDropped = (e) => dropped.push(e);
    process.on('unhandledRejection', onDropped);

    await check("an update whose apply rejects leaves the event unprocessed and reports the failure", async () => {
        dropped.length = 0;
        outcome = 'transient';
        try {
            const r = await deliver('evt-update-fails');
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(applies, 1, 'the plan was applied');
            assert.strictEqual(r.json.processed, false, 'the provider must not be told the update succeeded');
            assert.strictEqual(r.json.result, null, 'a failed plan has no result');
            const row = await stored('evt-update-fails');
            assert.strictEqual(row.processed_at, null, 'processed_at must stay NULL so the event is retried');
            assert.strictEqual(row.result, null);
            assert.match(row.last_error, /provider update failed: transient/);
            assert.strictEqual(row.attempts, 1);
            assert.deepStrictEqual(dropped, [], 'the rejection must be handled, not dropped');
        } finally {
            process.removeListener('unhandledRejection', onDropped);
            outcome = 'ok';
        }
    });

    await check('an update whose apply succeeds is applied and the event marked processed', async () => {
        const r = await deliver('evt-update-ok');
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.processed, true, r.text);
        assert.deepStrictEqual(r.json.result, { effect: 'updated', reason: 'flaky update' });
        const row = await stored('evt-update-ok');
        assert.ok(row.processed_at, 'the event is marked processed');
        assert.strictEqual(row.last_error, null);
    });

    delete t.app.locals.adapters.flaky;
    await t.close();
    done();
})();
