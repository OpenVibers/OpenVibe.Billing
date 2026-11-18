'use strict';
// The wallet's quest names never hold it up (11-18: the wallet was 2.1 s at p95; the read of Quest's catalog leaves
// through Cloudflare and takes 1.1 s from the server). The first read is waited for; past ten minutes the names answer
// at once and one read runs behind them; a failed read keeps the names it had.
const assert = require('assert');
const { questNames } = require('../server/ops/wallet');

(async () => {
    const catalog = { sites: [{ quests: [{ id: 'go-live', title: 'Go live once', url: '/quests/go-live' }] }] };
    const ctx = (fetchImpl) => ({ config: { quests: { url: 'https://openvibe.quest' } }, fetchImpl });
    const first = await questNames(ctx(async () => ({ ok: true, json: async () => catalog })));
    assert.strictEqual(first.get('go-live').name, 'Go live once', 'the first read is waited for');
    assert.strictEqual(first.get('go-live').url, 'https://openvibe.quest/quests/go-live');
    const realNow = Date.now;
    try {
        Date.now = () => realNow() + 11 * 60_000;
        let release; const slow = new Promise((r) => { release = r; }); let reads = 0;
        const t0 = realNow();
        const stale = await questNames(ctx(async () => { reads++; await slow; throw new Error('Quest is down'); }));
        assert.ok(realNow() - t0 < 200, 'a stale read answers at once');
        assert.strictEqual(stale.get('go-live').name, 'Go live once', 'with the names it had');
        release(); await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(reads, 1, 'one read ran behind it');
        Date.now = () => realNow() + 22 * 60_000;
        const kept = await questNames(ctx(async () => { throw new Error('still down'); }));
        assert.strictEqual(kept.get('go-live').name, 'Go live once', 'a failed read never wipes the names');
    } finally { Date.now = realNow; }
    console.log('wallet-quest-names: the first read waits; a stale one answers at once; a failed read keeps the names');
})().catch((err) => { console.error(err); process.exit(1); });
