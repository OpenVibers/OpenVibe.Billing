'use strict';
/** The expand migration carries pending legacy events into the SDK relay without touching the old table. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');
const { createServiceOutbox, outboxSchema } = require('openvibe-sdk/events');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-outbox-migrate-'));
    const migrations = path.join(__dirname, '..', 'migrations');
    const db = createDb({ pglite: true, service: 'billing-outbox-test' });
    try {
        for (const file of fs.readdirSync(migrations).filter((f) => /^000[1-5]_/.test(f))) {
            fs.copyFileSync(path.join(migrations, file), path.join(dir, file));
        }
        await db.migrate({ dir, log: { log() {} } });
        const event = { event_id: 'evt_legacy_pending', event_type: 'billing.transaction.settled', source: 'billing',
            timestamp: '2026-10-09T12:34:56.000Z', version: 1, payload: {} };
        await db.query('INSERT INTO outbox (event_id, event, created_at, attempts) VALUES ($1, $2, $3, $4)',
            [event.event_id, JSON.stringify(event), event.timestamp, 2]);
        const sent = { ...event, event_id: 'evt_legacy_sent' };
        await db.query('INSERT INTO outbox (event_id, event, created_at, sent_at) VALUES ($1, $2, $3, $4)',
            [sent.event_id, JSON.stringify(sent), sent.timestamp, event.timestamp]);
        const ddl = fs.readFileSync(path.join(migrations, '0006_sdk_outbox.sql'), 'utf8');
        assert.ok(ddl.includes(outboxSchema('service_outbox')));
        fs.copyFileSync(path.join(migrations, '0006_sdk_outbox.sql'), path.join(dir, '0006_sdk_outbox.sql'));
        await db.migrate({ dir, log: { log() {} } });
        const rows = await db.many('SELECT event_id, envelope, created_at, attempts FROM service_outbox');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].event_id, event.event_id);
        assert.strictEqual(rows[0].attempts, 2);
        assert.strictEqual(Number(rows[0].created_at), Date.parse(event.timestamp));

        const off = createServiceOutbox({ db, source: 'billing', table: 'service_outbox' });
        off.start();
        assert.deepStrictEqual(await off.status(), { enabled: false, pending: 1, rejected: 0, last_error: null });
        await off.stop();
        assert.strictEqual(await db.value('SELECT count(*) FROM service_outbox WHERE sent_at IS NULL'), 1);

        const posted = [];
        let rejectBad = false;
        const fetch = async (url, options) => {
            if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'service-token', expires_in: 300 }), { status: 200 });
            const body = JSON.parse(options.body);
            posted.push({ url, authorization: options.headers.Authorization || options.headers.authorization, body });
            const events = body.events || [body];
            if (rejectBad && events.some((e) => e.event_id === 'evt_bad')) {
                return new Response(JSON.stringify({ code: 'events.invalid_envelope' }), { status: 422 });
            }
            return new Response(JSON.stringify(body.events
                ? { results: events.map((e) => ({ event_id: e.event_id, seq: 7, duplicate: false })) }
                : { event_id: body.event_id, seq: 7, duplicate: false }), { status: 201 });
        };
        const outbox = createServiceOutbox({ db, source: 'billing', table: 'service_outbox', eventsUrl: 'http://events.test',
            networkInternalUrl: 'http://network.test', clientId: 'billing', clientSecret: 'secret', fetch, autoDiscover: false });
        assert.strictEqual((await outbox.status()).pending, 1);
        assert.deepStrictEqual(await outbox.outbox.flush(), { sent: 1, failed: 0, rejected: 0 });
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].body.event_id, event.event_id);
        assert.strictEqual((await outbox.status()).pending, 0);
        assert.strictEqual(await db.value('SELECT count(*) FROM outbox'), 2);
        const later = { ...event, event_id: 'evt_new_committed' };
        await db.tx(async () => { await outbox.emit(later); });
        assert.strictEqual(await db.value("SELECT count(*) FROM service_outbox WHERE event_id = 'evt_new_committed'"), 1);
        await assert.rejects(db.tx(async () => {
            await outbox.emit({ ...event, event_id: 'evt_new_rolled_back' });
            throw new Error('roll back the change');
        }), /roll back the change/);
        assert.strictEqual(await db.value("SELECT count(*) FROM service_outbox WHERE event_id = 'evt_new_rolled_back'"), 0);
        rejectBad = true;
        await db.tx(async () => {
            await outbox.emit({ ...event, event_id: 'evt_bad' });
            await outbox.emit({ ...event, event_id: 'evt_after_bad' });
        });
        assert.deepStrictEqual(await outbox.outbox.flush(), { sent: 2, failed: 0, rejected: 1 });
        assert.strictEqual((await outbox.status()).rejected, 1);
        assert.strictEqual((await outbox.status()).pending, 0);
        console.log('sdk outbox migration: all passed');
    } finally {
        await db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
