'use strict';
/**
 * Ask 273, Billing part: GET /api/me/balances/changes (a gain, a loss, a cursor, another person's
 * balance refused) and PUT /api/me/balances/read (the person's own read state), plus the
 * billing.balance.changed subject-visible message a balance move emits for an open page.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, fund, check, done } = require('./helpers/app');
const transfers = require('../server/ops/transfers');

const key = (p) => `${p}:${crypto.randomBytes(8).toString('hex')}`;

(async () => {
    console.log('balances changes');
    const t = await boot({ env: { BILLING_AUTHORITY: 'billing' } });
    const bob = t.user(102, 'bob');
    const ann = t.user(101, 'ann');
    const bobToken = t.network.signUser({ subject_id: bob.id, username: 'bob' });
    const annToken = t.network.signUser({ subject_id: ann.id, username: 'ann' });

    const get = async (token, q = '') => {
        const r = await fetch(`${t.base}/api/me/balances/changes${q}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        return { status: r.status, body: await r.json() };
    };
    const putRead = async (token, body) => {
        const r = await fetch(`${t.base}/api/me/balances/read`, {
            method: 'PUT', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json() };
    };

    const funded = await fund(t, bob.id, 500);
    const tip = await transfers.create(t.ctx, {
        from: bob.id, to: ann.id, amount: 100, idempotencyKey: key('tip'), actor: { principal: `user:${bob.id}` },
    });

    await check('a gain: bought Vibes arrive received with their reason', async () => {
        const { status, body } = await get(bobToken);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.currency, 'vibes');
        assert.deepStrictEqual(body.balance, { credit: 400, payable: 0 });
        assert.strictEqual(body.moves.length, 2);
        assert.strictEqual(body.moves[0].id, funded.id);
        assert.strictEqual(body.moves[0].delta, 500);
        assert.strictEqual(body.moves[0].part, 'received');
        assert.ok(body.moves[0].label, 'a plain-words reason rides along');
        assert.ok(body.moves[0].reason_key, 'and the ledger key for support');
        assert.deepStrictEqual(body.parts, { earned: 0, spent: 0, received: 500, sent: -100 });
        assert.strictEqual(body.net, 400);
        assert.strictEqual(body.cursor, tip.txn.id);
        assert.strictEqual(body.next_since, null);
    });

    await check("a loss: the tip leaves as sent, and the creator's side is earned", async () => {
        const { body } = await get(bobToken);
        assert.strictEqual(body.moves[1].delta, -100);
        assert.strictEqual(body.moves[1].part, 'sent');
        const annChanges = (await get(annToken)).body;
        assert.strictEqual(annChanges.moves.length, 1);
        assert.strictEqual(annChanges.moves[0].delta, 100);
        assert.strictEqual(annChanges.moves[0].part, 'earned');
        assert.deepStrictEqual(annChanges.parts, { earned: 100, spent: 0, received: 0, sent: 0 });
        assert.deepStrictEqual(annChanges.balance, { credit: 0, payable: 100 });
    });

    await check('a cursor: since replays only what came after', async () => {
        const { status, body } = await get(bobToken, `?since=${funded.id}`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.since, funded.id);
        assert.strictEqual(body.moves.length, 1);
        assert.strictEqual(body.moves[0].id, tip.txn.id);
        assert.deepStrictEqual(body.parts, { earned: 0, spent: 0, received: 0, sent: -100 });
        assert.strictEqual(body.net, -100);
        assert.strictEqual((await get(bobToken, '?since=nope')).status, 422, 'a made-up cursor is refused');
    });

    await check("another person's balance is refused: no subject parameter, tokens only open their own", async () => {
        assert.strictEqual((await get(null)).status, 401);
        assert.strictEqual((await get(t.network.signService({ cap: ['billing.*'] }))).status, 401, 'a service token is not a person');
        assert.strictEqual((await get(`${bobToken.slice(0, -4)}AAAA`)).status, 401);
        const annSeenByBob = (await get(bobToken)).body.moves.filter((m) => m.delta === 100 && m.part === 'earned');
        assert.strictEqual(annSeenByBob.length, 0, 'bob never sees ann’s earned move');
        assert.strictEqual((await get(bobToken, '?currency=coins')).status, 422);
    });

    await check('read state: marking read empties "since I last looked", and it only moves forward', async () => {
        const marked = await putRead(bobToken, { currency: 'vibes', cursor: tip.txn.id });
        assert.strictEqual(marked.status, 200);
        assert.strictEqual(marked.body.read_cursor, tip.txn.id);
        const after = await get(bobToken);
        assert.strictEqual(after.body.moves.length, 0, 'nothing since the look');
        assert.strictEqual(after.body.cursor, tip.txn.id);
        assert.strictEqual(after.body.read_cursor, tip.txn.id);
        assert.strictEqual((await putRead(bobToken, { currency: 'vibes', cursor: funded.id })).status, 409, 'looking backwards is refused');
        assert.strictEqual((await putRead(bobToken, { currency: 'vibes', cursor: 'txn_00000000000000000000000000' })).status, 422);
        assert.strictEqual((await putRead(null, { currency: 'vibes', cursor: tip.txn.id })).status, 401);
    });

    await check('a balance move emits billing.balance.changed, subject-visible, per person', async () => {
        const rows = await t.db.prepare(`SELECT envelope AS event FROM service_outbox
            WHERE (envelope #>> '{event_type}') = 'billing.balance.changed' ORDER BY id`).all();
        const events = rows.map((r) => (typeof r.event === 'string' ? JSON.parse(r.event) : r.event));
        assert.strictEqual(events.length, 3, `fund + tip tip both sides, got ${events.length}`);
        for (const e of events) {
            assert.strictEqual(e.visibility, 'subject', 'only the person sees their own over realtime');
            assert.strictEqual(e.subject.type, 'user');
            assert.strictEqual(e.payload.currency, 'vibes');
        }
        const bobEvents = events.filter((e) => e.subject.id === bob.id);
        assert.deepStrictEqual(bobEvents.map((e) => e.payload.delta), [500, -100], 'one message per move, in order');
        assert.deepStrictEqual(
            { credit: bobEvents[1].payload.credit, payable: bobEvents[1].payload.payable }, { credit: 400, payable: 0 });
        const annEvents = events.filter((e) => e.subject.id === ann.id);
        assert.strictEqual(annEvents.length, 1);
        assert.strictEqual(annEvents[0].payload.delta, 100);
    });

    await t.close();
    done();
})();
