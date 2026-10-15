'use strict';
/**
 * Request telemetry (openvibe-sdk/service, plan T1 step 10): app.js mounts the process-wide telemetryMiddleware (a no-op
 * until init), server/index.js calls telemetry.init() for service 'billing' with a PostgreSQL sink, starts the 30-day
 * retention and flushes on stop. Five hits on one route flush as ONE aggregated http.request sample; /metrics and
 * /shared make none; the retention deletes only rows older than 14 days.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { telemetry } = require('openvibe-sdk/service');
const { pruneTelemetry } = require('openvibe-sdk/telemetry');
const { boot } = require('./helpers/app');
(async () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    assert.match(read('server/index.js'), /telemetry\.init\(\{ service: 'billing', sink: createPgTelemetrySink\(/, 'index.js starts the collector');
    assert.match(read('server/index.js'), /startTelemetryRetention\(/, 'index.js starts the retention');
    assert.match(read('server/index.js'), /[Rr]etention\.stop\(\); await telemetry\.stop\(\);/, 'the stop flushes');

    const t = await boot();
    const samples = [];
    telemetry.init({ service: 'billing', sink: async (batch) => { samples.push(...batch); }, intervalMs: 3600e3 });
    const requests = () => samples.filter((s) => s.operation === 'http.request');
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await t.call('GET', '/policy', { token: null })).status, 200);
        await telemetry.flush();
        const hit = requests().filter((s) => s.resource === '/policy' && s.status === '2xx');
        assert.strictEqual(hit.length, 1, JSON.stringify(requests()));
        assert.strictEqual(hit[0].service, 'billing');
        assert.strictEqual(hit[0].extra.count, 5);

        samples.length = 0;
        await await t.call('GET', '/metrics', { token: null });
        await await t.call('GET', '/shared/navbar.js', { token: null });
        await telemetry.flush();
        assert.deepStrictEqual(requests(), [], '/metrics and /shared make no sample');

        const db = t.db;
        await db.query('DELETE FROM telemetry_samples');
        const insert = (days) => db.query("INSERT INTO telemetry_samples (at, service, operation) VALUES (now() - make_interval(days => $1), 'billing', 'http.request')", [days]);
        await insert(20);
        await insert(1);
        assert.strictEqual(await pruneTelemetry({ db, olderThanDays: 14 }), 1);
        assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM telemetry_samples')).rows[0].n, 1);
        console.log('telemetry ok');
    } finally {
        await telemetry.stop();
        await t.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
