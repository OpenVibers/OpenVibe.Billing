'use strict';
/**
 * Per-person limits on the money-creating routes (server/api/actor-limits.js, roadmap WS-R task 4), on a
 * fixed limiter clock: past its limit one person gets 429 problem+json `rate_limited` with Retry-After,
 * before the idempotency store and the ledger, whichever service sends the request, while another person
 * still passes; the window reopens and the same Idempotency-Key then goes through. Checkouts, transfers,
 * refunds (counted against the payer) and payout requests have their own numbers. Balance reads, the
 * provider webhooks, health, ready, release.json and metrics are never limited; refusals are logged (no
 * token) and counted.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

(async () => {
    // 15 s into a minute: the minute window has 45 s left. A person's history reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const t = await boot({ limitsNow: () => clock, env: { BILLING_LIMITS_MINUTE: '3', BILLING_LIMITS_HOUR: '100' } });
    const fan = t.user(31);
    const other = t.user(32);
    const creator = t.user(33);
    const second = t.user(34);
    console.log('actor limits');
    const count = async (table) => (await t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
    const checkout = (subject, o = {}) => t.call('POST', '/api/v1/intents', { cap: ['billing.intent.create'], body: { provider: 'powerchat', kind: 'purchase', subject, bits: 500 }, ...o });

    await check('checkouts: 5 a minute per person, then 429 rate_limited with Retry-After; nothing is stored', async () => {
        for (let i = 0; i < 5; i++) assert.strictEqual((await checkout(fan)).status, 201, `checkout ${i + 1}`);
        const before = await count('payment_intents');
        const r = await checkout(fan, { key: 'limits-retry-key-1' });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.strictEqual(r.headers.get('content-type'), 'application/problem+json');
        assert.deepStrictEqual([r.json.code, r.json.status, r.json.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(r.json.detail.includes('billing.intent.create'), r.json.detail);
        assert.strictEqual(await count('payment_intents'), before, 'no intent stored');
        assert.strictEqual((await t.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key = 'limits-retry-key-1'").get()).n, 0, 'the refusal is not an idempotent answer');
    });

    await check('counted per person, not per service: another service for the same person is refused, another person passes', async () => {
        assert.strictEqual((await checkout(fan, { sub: 'svc:tips' })).status, 429, 'Tips speaking for the same person');
        assert.strictEqual((await checkout(other)).status, 201, 'another person still starts a checkout');
    });

    await check('the next minute reopens, and the refused Idempotency-Key goes through', async () => {
        clock += 45 * 1000;
        const r = await checkout(fan, { key: 'limits-retry-key-1' });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('transfers: 60 a minute per payer; the 61st moves nothing; another payer passes', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        await fund(t, fan, 10000);
        await fund(t, other, 1000);
        for (let i = 0; i < 60; i++) {
            const r = await t.call('POST', '/api/v1/transfers', { body: { from: fan, to: creator, amount: 10 } });
            if (r.status !== 201) assert.fail(`transfer ${i + 1}: ${r.text}`);
        }
        const credit = (await t.balances(fan.id)).credit;
        const r = await t.call('POST', '/api/v1/transfers', { body: { from: fan, to: creator, amount: 10 } });
        assert.deepStrictEqual([r.status, r.json.code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
        assert.strictEqual((await t.balances(fan.id)).credit, credit, 'no money moved');
        assert.strictEqual((await t.call('POST', '/api/v1/transfers', { body: { from: other, to: creator, amount: 10 } })).status, 201);
    });

    await check('refunds count against the payer: 20 a minute', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 10, 0);
        const tip = await t.call('POST', '/api/v1/transfers', { body: { from: other, to: creator, amount: 100 } });
        assert.strictEqual(tip.status, 201, tip.text);
        const id = tip.json.transaction.id;
        for (let i = 0; i < 20; i++) {
            const r = await t.call('POST', `/api/v1/transfers/${id}/refund`, { body: { amount: 1, reason: 'test' }, sub: i % 2 ? 'svc:tips' : 'svc:live' });
            if (r.status !== 201) assert.fail(`refund ${i + 1}: ${r.text}`);
        }
        const r = await t.call('POST', `/api/v1/transfers/${id}/refund`, { body: { amount: 1, reason: 'test' } });
        assert.deepStrictEqual([r.status, r.json.code], [429, 'rate_limited']);
    });

    await check('payout requests: 3 a minute per creator; nothing is escrowed past it; another creator passes', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 15, 0);
        await fund(t, second, 1000);
        await t.call('POST', '/api/v1/transfers', { body: { from: second, to: creator, amount: 1000 } });
        const tipSecond = await t.call('POST', '/api/v1/transfers', { body: { from: other, to: second, amount: 800 } });
        assert.strictEqual(tipSecond.status, 201, tipSecond.text);
        const cashout = (subject) => t.call('POST', '/api/v1/cashouts', { body: { subject, amount: 500, payout_method: { type: 'paypal', address: 'creator@example.com' } } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await cashout(creator)).status, 201, `cashout ${i + 1}`);
        const before = await count('cashouts');
        const r = await cashout(creator);
        assert.deepStrictEqual([r.status, r.json.code], [429, 'rate_limited']);
        assert.strictEqual(await count('cashouts'), before, 'nothing escrowed');
        const ok = await cashout(second);
        assert.strictEqual(ok.status, 201, ok.text);
    });

    await check('history reads per person (BILLING_LIMITS_MINUTE); balance reads are never limited', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 20, 0);
        const history = (who) => t.call('GET', `/api/v1/transactions?subject=${who.id}`, { cap: ['billing.balance.read'] });
        for (let i = 0; i < 3; i++) assert.strictEqual((await history(fan)).status, 200);
        assert.strictEqual((await history(fan)).status, 429);
        assert.strictEqual((await history(other)).status, 200, 'another person still reads');
        for (let i = 0; i < 8; i++) assert.strictEqual((await t.call('GET', `/api/v1/balances/${fan.id}`, { cap: ['billing.balance.read'] })).status, 200);
    });

    await check('provider webhooks, health, ready, release.json and metrics are never limited', async () => {
        for (let i = 0; i < 8; i++) {
            const d = await t.powerchat({ type: 'donation.completed', streamer: { id: 'pc1', username: 'openvibe' }, data: { eventId: `limits-${i}`, amountUsdCents: 100 } });
            assert.notStrictEqual(d.status, 429, JSON.stringify(d.json));
            assert.strictEqual((await t.call('GET', '/api/health', { token: null })).status, 200);
            assert.notStrictEqual((await t.call('GET', '/api/ready', { token: null })).status, 429);
            assert.strictEqual((await t.call('GET', '/release.json', { token: null })).status, 200);
            assert.strictEqual((await t.call('GET', '/metrics', { token: null })).status, 200);
        }
    });

    await check('refusals are logged (the person, never a token) and counted in billing_rate_limited_total', async () => {
        assert.ok(t.logs.includes(`[Billing] limit billing.intent.create: user:${fan.id} refused, over 5 per minute`), t.logs.join('\n'));
        assert.ok(t.logs.includes(`[Billing] limit billing.transfer.refund: user:${other.id} refused, over 20 per minute`), t.logs.join('\n'));
        assert.ok(!t.logs.some((l) => /Bearer|eyJ/.test(l)), 'no token in the log');
        const m = (await t.call('GET', '/metrics', { token: null })).text;
        const lines = m.split('\n').filter((l) => l.includes('billing_rate_limited_total')).join('\n');
        for (const [name, n] of [['billing.intent.create', 2], ['billing.transfer.create', 1], ['billing.transfer.refund', 1], ['billing.cashout.request', 1], ['billing.history.read', 1]]) {
            assert.ok(new RegExp(`billing_rate_limited_total\\{limit="${name.replace(/\./g, '\\.')}",window="minute"\\} ${n}`).test(m), `${name}:\n${lines}`);
        }
        await t.assertReconciled('after the refusals');
    });

    await t.close();
    done();
})();
