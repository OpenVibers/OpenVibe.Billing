'use strict';
/**
 * Usage readings (platform.usage-sample@1; ops/usage.js, migrations/0002_usage.sql): POST /api/v1/usage validates
 * and stores a reading — the indexed fields as columns, the whole reading as jsonb — idempotently by its own
 * idempotency_key (a replay returns the stored row, a different reading under the key is 409); GET /api/v1/usage
 * filters by project, subject, service and time and pages with a cursor. Service tokens only. Nothing is charged:
 * the journal is untouched.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');

const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRJ2 = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPR';
let n = 0;
const reading = (over = {}) => {
    n++;
    return {
        id: `use-${n}`, idempotency_key: `media:delivery:${n}`, service: 'media', project: PRJ, subject: 'user:usr_01JAB2C3D4E5F6G7H8J9K0MNPQ',
        resource: 'object-1', provider: 'local', operation: 'deliver', quantity: 1.5, unit: 'GiB', at: '2026-09-30T10:00:00Z', source: 'media.egress',
        ...over,
    };
};
const REC = ['billing.usage.record'];
const counts = async (db) => ({
    usage: (await db.prepare('SELECT COUNT(*) AS n FROM usage_records').get()).n,
    txns: (await db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).n,
    entries: (await db.prepare('SELECT COUNT(*) AS n FROM ledger_entries').get()).n,
});

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
    console.log('usage readings');
    const t = await boot();
    const post = (body, opts = {}) => t.call('POST', '/api/v1/usage', { body, cap: REC, key: null, sub: 'svc:media', ...opts });
    const get = (qs, opts = {}) => t.call('GET', `/api/v1/usage${qs ? `?${qs}` : ''}`, { cap: REC, ...opts });

    await check('a full reading (all 15 plan fields) is stored: columns plus the reading as jsonb; nothing is charged', async () => {
        const before = await counts(t.db);
        const body = reading({ node: 'node-1', cell: 'cell-west', region: 'us-west', cost_estimate: 0.03, free_allowance_used: 1, vibes_charged: 250, route_epoch: 7, trace_id: '0af7651916cd43dd8448eb211c80319c' });
        const r = await post(body);
        assert.strictEqual(r.status, 201, r.text);
        const rec = r.json.record;
        assert.deepStrictEqual(rec.reading, body);
        assert.strictEqual(rec.idempotency_key, body.idempotency_key);
        assert.strictEqual(rec.project, PRJ);
        assert.strictEqual(rec.subject, body.subject);
        assert.strictEqual(rec.service, 'media');
        assert.strictEqual(rec.at, '2026-09-30T10:00:00.000Z');
        assert.strictEqual(rec.principal, 'svc:media');
        const row = await t.db.prepare('SELECT * FROM usage_records WHERE idempotency_key = ?').get(body.idempotency_key);
        assert.deepStrictEqual(row.reading, body);
        assert.strictEqual(row.reading.vibes_charged, 250);
        const after = await counts(t.db);
        assert.deepStrictEqual(after, { ...before, usage: before.usage + 1 });
    });

    await check('a reading with only the required fields is stored (project and subject null)', async () => {
        const { project, subject, resource, provider, ...minimal } = reading();
        const r = await post(minimal);
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json.record.project, null);
        assert.strictEqual(r.json.record.subject, null);
    });

    await check('an invalid reading is a 422 problem and nothing is stored', async () => {
        const before = (await counts(t.db)).usage;
        const { quantity, ...noQuantity } = reading();
        for (const bad of [noQuantity, reading({ extra: 1 }), reading({ project: 'prj_nope' }), reading({ quantity: -1 }), reading({ vibes_charged: 1.5 }),
            reading({ vibes_charged: -1 }), reading({ at: 'yesterday' }), reading({ quantity: 1, free_allowance_used: 2 }), []]) {
            const r = await post(bad);
            assert.strictEqual(r.status, 422, `${JSON.stringify(bad)} → ${r.status} ${r.text}`);
            assert.strictEqual(r.json.code, 'billing.invalid_input');
            assert.match(r.headers.get('content-type'), /application\/problem\+json/);
        }
        assert.strictEqual((await counts(t.db)).usage, before);
    });

    await check('a replay of the same reading returns the stored row (key order does not matter); a different one under the key is 409', async () => {
        const body = reading();
        const first = await post(body);
        assert.strictEqual(first.status, 201, first.text);
        const reordered = Object.fromEntries(Object.entries(body).reverse());
        const again = await post(reordered, { sub: 'svc:other' });
        assert.strictEqual(again.status, 200, again.text);
        assert.strictEqual(again.headers.get('idempotent-replayed'), 'true');
        assert.deepStrictEqual(again.json.record, first.json.record);
        const changed = await post({ ...body, quantity: 2 });
        assert.strictEqual(changed.status, 409, changed.text);
        assert.strictEqual(changed.json.code, 'billing.usage_key_reused');
        const rows = await t.db.prepare('SELECT * FROM usage_records WHERE idempotency_key = ?').all(body.idempotency_key);
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].reading.quantity, 1.5);
    });

    await check('service tokens with billing.usage.record only: no token 401, a user token 401, another capability 403', async () => {
        assert.strictEqual((await post(reading(), { token: null })).status, 401);
        const user = await userAccessToken(t);
        assert.ok(user);
        assert.strictEqual((await post(reading(), { token: user })).status, 401);
        assert.strictEqual((await get('', { token: user })).status, 401);
        const denied = await post(reading(), { cap: ['billing.transfer.create'] });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.json.code, 'capability.denied');
        assert.strictEqual((await post(reading(), { cap: ['billing.ledger.admin'] })).status, 403, 'admin reads readings, does not record them');
        assert.strictEqual((await get('', { cap: ['billing.ledger.admin'] })).status, 200);
        assert.strictEqual((await get('', { cap: ['billing.balance.read'] })).status, 403);
    });

    await check('readings are accepted while the economy is frozen (they move no money)', async () => {
        assert.strictEqual((await t.call('POST', '/api/v1/admin/freeze', { body: { on: true, reason: 'test' } })).status, 200);
        try {
            const r = await post(reading());
            assert.strictEqual(r.status, 201, r.text);
        } finally {
            assert.strictEqual((await t.call('POST', '/api/v1/admin/freeze', { body: { on: false } })).status, 200);
        }
    });
    await t.close();

    // ── Listing: filters and paging, on a fresh database ──
    const u = await boot();
    const uPost = (body) => u.call('POST', '/api/v1/usage', { body, cap: REC, key: null });
    const uGet = async (qs) => { const r = await u.call('GET', `/api/v1/usage?${qs}`, { cap: REC }); assert.strictEqual(r.status, 200, r.text); return r.json; };
    const seed = [
        reading({ project: PRJ, subject: 'user:a', service: 'media', at: '2026-09-01T00:00:00Z' }),
        reading({ project: PRJ, subject: 'user:b', service: 'media', at: '2026-09-02T00:00:00Z' }),
        reading({ project: PRJ2, subject: 'user:a', service: 'compute', at: '2026-09-03T00:00:00Z' }),
        reading({ project: PRJ2, subject: 'user:b', service: 'media', at: '2026-09-04T00:00:00+02:00' }),
        reading({ project: PRJ, subject: 'user:a', service: 'compute', at: '2026-09-05T00:00:00Z' }),
    ];
    for (const s of seed) assert.strictEqual((await uPost(s)).status, 201);
    const keys = (out) => out.records.map((r) => r.idempotency_key);
    const k = (i) => seed[i].idempotency_key;

    await check('GET filters by project, subject, service and the time range [from, to), newest first', async () => {
        assert.deepStrictEqual(keys(await uGet(`project=${PRJ}`)), [k(4), k(1), k(0)]);
        assert.deepStrictEqual(keys(await uGet('subject=user:a')), [k(4), k(2), k(0)]);
        assert.deepStrictEqual(keys(await uGet('service=compute')), [k(4), k(2)]);
        assert.deepStrictEqual(keys(await uGet(`project=${PRJ2}&service=media`)), [k(3)]);
        assert.deepStrictEqual(keys(await uGet('from=2026-09-02T00:00:00Z&to=2026-09-05T00:00:00Z')), [k(3), k(2), k(1)]);
        // 2026-09-04T00:00:00+02:00 is 2026-09-03T22:00Z: compared as a time, not as text.
        assert.deepStrictEqual(keys(await uGet('from=2026-09-03T21:00:00Z&to=2026-09-03T23:00:00Z')), [k(3)]);
        assert.deepStrictEqual(keys(await uGet('subject=user:nobody')), []);
    });

    await check('GET pages with a cursor until next_cursor is null; a bad cursor, limit or time is 422', async () => {
        const seen = [];
        let cursor = null;
        let pages = 0;
        do {
            const out = await uGet(`limit=2${cursor ? `&cursor=${cursor}` : ''}`);
            seen.push(...keys(out));
            cursor = out.next_cursor;
            pages++;
        } while (cursor && pages < 10);
        assert.strictEqual(pages, 3);
        assert.deepStrictEqual(seen, [k(4), k(3), k(2), k(1), k(0)]);
        for (const qs of ['cursor=nope', 'limit=0', 'from=yesterday', 'to=2026-13-40']) {
            const r = await u.call('GET', `/api/v1/usage?${qs}`, { cap: REC });
            assert.strictEqual(r.status, 422, `${qs} → ${r.status} ${r.text}`);
        }
    });
    await u.close();
    done();
})();
