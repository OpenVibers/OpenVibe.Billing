'use strict';
/**
 * EXTERNAL receipts (ADR-012; ops/external.js): a tip on a streamer's own PowerChat is never booked,
 * is stored once per payment in external_receipts, and is announced as billing.receipt.external —
 * exactly once, only when BILLING_AUTHORITY=billing and the receiving account belongs to a known
 * creator. While Live is the authority nothing is announced (Live's own webhook does it), so a tip is
 * never celebrated twice. Accounts come from Live's powerchat_connections (import) or an operator.
 */
const assert = require('assert');
const path = require('path');
const Database = require('better-sqlite3');
const { validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { startEvents } = require('./helpers/stubs');

const donation = (data, streamer = { id: 'pc-77', username: 'StreamerPC' }) => ({ type: 'donation.completed', streamer, data: { eventId: `don-${Math.random().toString(36).slice(2)}`, ...data } });
const externalEvents = (db) => db.prepare("SELECT event FROM outbox WHERE json_extract(event, '$.event_type') = 'billing.receipt.external' ORDER BY seq").all().map((r) => JSON.parse(r.event));

(async () => {
    console.log('external receipts');

    await check('BILLING_AUTHORITY must be live or billing; live is the default', async () => {
        const { loadConfig } = require('../server/config');
        assert.strictEqual(loadConfig({}).authority, 'live');
        assert.strictEqual(loadConfig({ BILLING_AUTHORITY: 'Billing' }).authority, 'billing');
        assert.throws(() => loadConfig({ BILLING_AUTHORITY: 'biling' }), /BILLING_AUTHORITY/);
    });

    // ── Live is the authority (shadow): recorded, never announced ──
    {
        const t = await boot();
        const streamer = t.user(40);
        await t.call('POST', '/api/v1/admin/provider-accounts', { body: { provider: 'powerchat', username: 'StreamerPC', account_id: 'pc-77', subject: streamer.id } });

        await check('while Live is the authority an EXTERNAL tip is recorded, not announced, and nothing is booked', async () => {
            const before = t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n;
            const r = await t.powerchat(donation({ eventId: 'ext-L1', amountUsdCents: 500, donorName: 'Fan', message: 'hi' }));
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.json.result.effect, 'external');
            assert.strictEqual(r.json.result.announced, false);
            assert.match(r.json.result.reason, /BILLING_AUTHORITY=live/);
            assert.strictEqual(externalEvents(t.db).length, 0, 'no billing.receipt.external while Live announces');
            const row = t.db.prepare("SELECT * FROM external_receipts WHERE receipt_ref = 'powerchat:ext-L1'").get();
            assert.deepStrictEqual([row.status, row.amount_cents, row.streamer_subject], ['not_announced', 500, streamer.id]);
            assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM transactions').get().n, before, 'EXTERNAL money is never journaled');
            const rec = t.assertReconciled('external under live');
            assert.strictEqual(rec.totals.external_receipts, 1);
            assert.strictEqual(rec.totals.external_announced, 0);
        });
        await t.close();
    }

    // ── Billing is the authority: announced once ──
    const t = await boot({ env: { BILLING_AUTHORITY: 'billing' } });
    const streamer = t.user(41);
    const other = t.user(42);

    await check('an operator maps a PowerChat account to a creator (validated, idempotent, allowed while frozen)', async () => {
        const bad = await t.call('POST', '/api/v1/admin/provider-accounts', { body: { provider: 'powerchat', username: 'has space', subject: streamer.id } });
        assert.strictEqual(bad.status, 422);
        const badSub = await t.call('POST', '/api/v1/admin/provider-accounts', { body: { provider: 'powerchat', username: 'streamerpc', subject: { type: 'user', id: '42' } } });
        assert.strictEqual(badSub.status, 422);
        const noCap = await t.call('POST', '/api/v1/admin/provider-accounts', { cap: ['billing.intent.create'], body: { provider: 'powerchat', username: 'streamerpc', subject: streamer.id } });
        assert.strictEqual(noCap.status, 403);
        await t.call('POST', '/api/v1/admin/freeze', { key: null, body: { on: true, reason: 'cutover' } });
        const ok = await t.call('POST', '/api/v1/admin/provider-accounts', { body: { provider: 'powerchat', username: 'StreamerPC', account_id: 'pc-77', subject: streamer.id } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.deepStrictEqual([ok.json.account.username, ok.json.account.subject, ok.json.account.source], ['streamerpc', streamer.id, 'admin']);
        await t.call('POST', '/api/v1/admin/freeze', { key: null, body: { on: false } });
        const list = await t.call('GET', '/api/v1/admin/provider-accounts');
        assert.strictEqual(list.json.accounts.length, 1);
    });

    let first;
    await check('an EXTERNAL tip is announced as billing.receipt.external with everything Tips needs', async () => {
        const r = await t.powerchat(donation({ eventId: 'ext-1', amountUsdCents: 1234, donorName: 'Generous Fan', message: 'love the stream', appPurpose: 'goal:12', occurredAt: '2026-09-23T20:00:00Z' }), { deliveryId: 'dlv-ext-1' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.json.result.effect, r.json.result.announced, r.json.result.streamer], ['external', true, streamer.id]);
        const evs = externalEvents(t.db);
        assert.strictEqual(evs.length, 1);
        first = evs[0];
        assert.ok(validate('events.event-envelope@1', first).valid);
        assert.deepStrictEqual([first.source, first.subject], ['billing', { type: 'provider_receipt', id: 'powerchat:ext-1' }]);
        const p = first.payload;
        assert.deepStrictEqual(p.streamer, { type: 'user', id: streamer.id });
        assert.deepStrictEqual([p.amount_cents, p.currency, p.value_bits], [1234, 'usd-cents', 1234]);
        assert.deepStrictEqual([p.donor_name, p.anonymous, p.message], ['Generous Fan', false, 'love the stream']);
        assert.deepStrictEqual([p.provider, p.provider_event_id, p.delivery_id, p.receipt_ref], ['powerchat', 'ext-1', 'dlv-ext-1', 'powerchat:ext-1']);
        assert.deepStrictEqual(p.receiving_account, { provider: 'powerchat', id: 'pc-77', username: 'streamerpc' });
        assert.deepStrictEqual([p.classification, p.app_purpose, p.test], ['EXTERNAL', 'goal:12', false]);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE receipt_ref = 'powerchat:ext-1'").get().n, 0);
        t.assertReconciled('after an announced external tip');
    });

    await check('a redelivery — same delivery id or a new one — announces nothing more', async () => {
        const same = await t.powerchat(donation({ eventId: 'ext-1', amountUsdCents: 1234 }), { deliveryId: 'dlv-ext-1' });
        assert.strictEqual(same.json.duplicate, true);
        const again = await t.powerchat(donation({ eventId: 'ext-1', amountUsdCents: 1234 }), { deliveryId: 'dlv-ext-1-retry' });
        assert.strictEqual(again.json.result.effect, 'duplicate_receipt');
        assert.strictEqual(externalEvents(t.db).length, 1);
        const firstEvent = t.db.prepare("SELECT id FROM provider_events WHERE provider_event_id = 'dlv-ext-1'").get().id;
        for (const id of [firstEvent, again.json.event]) {
            const refused = await t.call('POST', `/api/v1/admin/provider-events/${id}/reprocess`, { key: null });
            assert.strictEqual(refused.status, 409, 'an announced receipt (or its duplicate) is never re-run');
        }
        assert.strictEqual(externalEvents(t.db).length, 1);
        t.assertReconciled('after external redeliveries');
    });

    await check('an anonymous tip carries no donor name; the account is found by id when the username changed', async () => {
        const r = await t.powerchat(donation({ eventId: 'ext-anon', amountUsdCents: 300, donorName: 'Real Name', isAnonymous: true }, { id: 'pc-77', username: 'renamedpc' }));
        assert.strictEqual(r.json.result.announced, true);
        const p = externalEvents(t.db).find((e) => e.payload.provider_event_id === 'ext-anon').payload;
        assert.deepStrictEqual([p.donor_name, p.anonymous, p.streamer.id], [null, true, streamer.id]);
    });

    await check('a tip on an account no creator connected is held for review; mapped and reprocessed, it is announced once', async () => {
        const r = await t.powerchat(donation({ eventId: 'ext-unknown', amountUsdCents: 700, donorName: 'Someone' }, { id: 'pc-99', username: 'OtherPC' }));
        assert.deepStrictEqual([r.json.result.effect, r.json.result.announced, r.json.result.review], ['external', false, true]);
        assert.match(r.json.result.reason, /otherpc/);
        const rec = t.assertReconciled('with an unmapped external tip');
        assert.ok(rec.warnings.events_for_review.some((e) => e.id === r.json.event));
        const n = externalEvents(t.db).length;
        await t.call('POST', '/api/v1/admin/provider-accounts', { body: { provider: 'powerchat', username: 'otherpc', subject: other.id } });
        const re = await t.call('POST', `/api/v1/admin/provider-events/${r.json.event}/reprocess`, { key: null });
        assert.strictEqual(re.status, 200, re.text);
        assert.deepStrictEqual([re.json.event.result.effect, re.json.event.result.announced], ['external', true]);
        assert.strictEqual(externalEvents(t.db).length, n + 1);
        assert.strictEqual(externalEvents(t.db).at(-1).payload.streamer.id, other.id);
        assert.strictEqual(t.db.prepare("SELECT status FROM external_receipts WHERE receipt_ref = 'powerchat:ext-unknown'").get().status, 'announced');
    });

    await check('an underpaid direct subscription is an EXTERNAL tip to the intent\'s streamer', async () => {
        const i = await t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', kind: 'subscription', subject: other, streamer, route: 'direct', receiving_account: 'StreamerPC' } });
        assert.strictEqual(i.status, 201, i.text);
        const r = await t.powerchat(donation({ eventId: 'ext-under', amountUsdCents: 200, appExternalRef: i.json.intent.checkout_ref }));
        assert.deepStrictEqual([r.json.result.effect, r.json.result.announced, r.json.result.streamer], ['external', true, streamer.id]);
        const e = await t.call('GET', `/api/v1/entitlements/${other.id}?streamer=${streamer.id}`);
        assert.strictEqual(e.json.active, false, 'underpaid: no subscription');
    });

    await check('zero, test and out-of-range amounts announce nothing', async () => {
        const n = externalEvents(t.db).length;
        const zero = await t.powerchat(donation({ amountUsdCents: 0 }));
        assert.strictEqual(zero.json.result.effect, 'none');
        const test = await t.powerchat(donation({ amountUsdCents: 500, isTest: true }));
        assert.strictEqual(test.json.result.effect, 'none');
        const huge = await t.powerchat(donation({ amountUsdCents: 1e20 }));
        assert.deepStrictEqual([huge.json.result.effect, huge.json.result.review], ['none', true]);
        const inf = await t.powerchat(donation({ amountUsdCents: '1e400' }));
        assert.strictEqual(inf.json.result.effect, 'none');
        assert.strictEqual(externalEvents(t.db).length, n);
        t.assertReconciled('after refused external amounts');
    });

    await check('the outbox relay publishes billing.receipt.external to OpenVibe.Events', async () => {
        const events = await startEvents();
        const { createRelay } = require('../server/outbox');
        const relay = createRelay({ db: t.db, config: { ...t.config, events: { url: events.url, intervalMs: 1000 } }, log: { warn() {} } });
        await relay.flush();
        const sent = events.batches.flatMap((b) => b.events).filter((e) => e.event_type === 'billing.receipt.external');
        assert.strictEqual(sent.length, externalEvents(t.db).length);
        assert.strictEqual(sent[0].event_id, first.event_id);
        await events.close();
    });

    await check('the importer maps Live\'s powerchat_connections (never over an operator\'s mapping); --accounts-only alone', async () => {
        const file = path.join(t.dir, 'live-accounts.db');
        const live = new Database(file);
        live.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, openvibe_bucks_balance REAL DEFAULT 0, openvibe_bucks_cashout_balance REAL DEFAULT 0);
            CREATE TABLE powerchat_connections (user_id INTEGER PRIMARY KEY, powerchat_username TEXT, powerchat_user_id TEXT);
            INSERT INTO users (id, username) VALUES (50, 'newbie'), (51, 'ghost'), (52, 'clash');
            INSERT INTO powerchat_connections VALUES (50, 'NewbiePC', 'pc-50'), (51, 'GhostPC', 'pc-51'), (52, 'StreamerPC', 'pc-77'), (53, 'bad name!', NULL);`);
        live.close();
        const newbie = t.network.addUser(50);
        t.network.addUser(52);
        t.network.addUser(53);
        const { importProviderAccounts, importLive } = require('../server/importer/live');
        const ro = new Database(file, { readonly: true });
        const dry = await importProviderAccounts(t.ctx, { live: ro, resolveLiveUsers: t.ctx.network.resolveLiveUsers, dryRun: true, log: {} });
        assert.strictEqual(dry.provider_accounts.mapped, 1);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM provider_accounts WHERE username = 'newbiepc'").get().n, 0, 'dry run keeps nothing');
        const rep = await importProviderAccounts(t.ctx, { live: ro, resolveLiveUsers: t.ctx.network.resolveLiveUsers, log: {} });
        const a = rep.provider_accounts;
        assert.strictEqual(a.mapped, 1);
        assert.deepStrictEqual(a.unmapped.map((u) => [u.live_user_id, u.reason]), [[51, 'no Network subject'], [53, 'not a PowerChat username']]);
        assert.deepStrictEqual(a.kept_admin.map((k) => k.username), ['streamerpc']);
        const row = t.db.prepare("SELECT * FROM provider_accounts WHERE username = 'newbiepc'").get();
        assert.deepStrictEqual([row.subject, row.account_id, row.source, row.live_user_id], [newbie, 'pc-50', 'live-import', 50]);
        assert.strictEqual(t.db.prepare("SELECT subject FROM provider_accounts WHERE username = 'streamerpc'").get().subject, streamer.id);
        const full = await importLive(t.ctx, { live: ro, resolveLiveUsers: t.ctx.network.resolveLiveUsers, log: {} });
        assert.strictEqual(full.provider_accounts.unchanged, 1, 'the full import runs the same step; a re-run changes nothing');
        ro.close();
        const r = await t.powerchat(donation({ eventId: 'ext-newbie', amountUsdCents: 100 }, { id: 'pc-50', username: 'NewbiePC' }));
        assert.strictEqual(r.json.result.streamer, newbie);
        t.assertReconciled('after the accounts import');
    });

    await t.close();
    done();
})();
