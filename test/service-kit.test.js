'use strict';
/**
 * openvibe-sdk/service in Billing (plan T1): the SIGTERM/SIGINT shutdown is the kit's gracefulStop, not a
 * hand-written handler. The job timers, the outbox relay and the Network key refresh stop; the HTTP server
 * drains (requests in flight get Connection: close); then Valkey and the database close, and the process
 * exits 0 — past 5 s too, matching manifests/services/billing.json lifecycle.shutdown (deadlineSeconds 5).
 * The static half reads server/index.js; the behavioural half drives gracefulStop with the same options
 * Billing passes, exits stubbed.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { gracefulStop } = require('openvibe-sdk/service');
const { check, done } = require('./helpers/app');

const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };

const callAt = source.indexOf('gracefulStop({');
const call = callAt === -1 ? '' : source.slice(callAt, callAt + 1000);

/** GET with node:http (the Connection header and the socket are visible). */
function request(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
            res.on('error', reject);
        });
        req.on('error', reject);
    });
}

async function waitFor(fn, ms = 2000) {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 5));
    }
}

(async () => {
    console.log('service-kit');

    await check('server/index.js imports gracefulStop from openvibe-sdk/service and owns no signal handler', () => {
        assert.match(source, /const \{ gracefulStop \} = require\('openvibe-sdk\/service'\)/);
        assert.doesNotMatch(source, /process\.on\('SIGTERM'/, 'server/index.js still installs its own SIGTERM handler');
        assert.doesNotMatch(source, /process\.on\('SIGINT'/, 'server/index.js still installs its own SIGINT handler');
        assert.doesNotMatch(source, /process\.exit\(0\), 5000\)/, 'the old 5 s exit-0 timer is gone');
    });

    await check('the one stop names Billing and keeps the 5 s deadline, exit 0 and the 65 s keep-alive', () => {
        assert.notStrictEqual(callAt, -1, 'gracefulStop is not called in the entry point');
        assert.strictEqual(source.indexOf('gracefulStop({', callAt + 1), -1, 'more than one gracefulStop call');
        assert.match(call, /name: 'Billing'/);
        assert.match(call, /deadlineMs: 5000/);
        assert.match(call, /deadlineExitCode: 0/);
        assert.match(source, /server\.keepAliveTimeout = 65_000/);
    });

    await check('the stop steps stop the timers, the relay then the key refresh; the close steps close Valkey then the database', () => {
        const stop = call.slice(call.indexOf('stop: ['), call.indexOf('close: ['));
        const close = call.slice(call.indexOf('close: ['));
        const a = stop.indexOf('timers');
        const b = stop.indexOf('relay.stop()');
        const c = stop.indexOf('keys.stop()');
        assert.ok(a !== -1 && b !== -1 && c !== -1 && a < b && b < c, 'stop steps must be the timers, relay.stop(), keys.stop()');
        const v = close.indexOf('valkey');
        const d = close.indexOf('ctx.db.close()');
        assert.ok(v !== -1 && d !== -1 && v < d, 'close steps must be Valkey, then the database');
    });

    await check('the kit drains the server, closes in order, exits once, and a second stop is a no-op', async () => {
        const order = [];
        let release;
        const gate = new Promise((r) => { release = r; });
        let slowArrived = false;
        const server = http.createServer((req, res) => {
            if (req.url === '/fast') return res.end('fast');
            slowArrived = true;
            res.on('finish', () => order.push('slow finished'));
            return gate.then(() => res.end('done'));
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        server.keepAliveTimeout = 65000;
        const url = `http://127.0.0.1:${server.address().port}`;

        const exits = [];
        const kit = gracefulStop({
            name: 'Billing', server, deadlineMs: 5000, deadlineExitCode: 0, signals: false, log: quiet, exit: (c) => exits.push(c),
            stop: [
                () => order.push('timers'),
                () => order.push('relay.stop'),
                () => order.push('keys.stop'),
            ],
            close: [
                () => order.push('valkey.close'),
                () => order.push('db.close'),
            ],
        });
        try {
            const inflight = request(`${url}/slow`);
            await waitFor(() => slowArrived);

            assert.strictEqual(kit.stopping(), false);
            const stopped = kit.stop('SIGTERM');
            assert.strictEqual(kit.stopping(), true, 'stopping() turns true at once');
            await waitFor(() => order.includes('keys.stop'));
            assert.ok(!order.includes('db.close'), 'close steps wait for the drain');

            release();
            const r = await inflight;
            assert.strictEqual(r.text, 'done');
            assert.strictEqual(r.headers.connection, 'close', 'a request in flight is answered with Connection: close');
            assert.strictEqual(await stopped, 0, 'the stop resolves with exit code 0');
            assert.deepStrictEqual(order, ['timers', 'relay.stop', 'keys.stop', 'slow finished', 'valkey.close', 'db.close']);
            assert.deepStrictEqual(exits, [0], 'exit is called once, with 0');
            assert.strictEqual(server.listening, false, 'the HTTP server stops listening');

            const again = await kit.stop('SIGINT');
            assert.strictEqual(again, 0, 'a second stop resolves with the same code');
            assert.deepStrictEqual(order, ['timers', 'relay.stop', 'keys.stop', 'slow finished', 'valkey.close', 'db.close'], 'a second stop runs no step again');
            assert.deepStrictEqual(exits, [0], 'exit stays called once');
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });

    done();
})();
