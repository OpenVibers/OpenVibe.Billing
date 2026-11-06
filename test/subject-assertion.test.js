'use strict';
/**
 * Subject assertions on the money routes (server/api/subject-assertion.js; ADR-003, the 2026-11-06
 * amendment; plan H1).
 *
 * A money route that names a person checks the person's own Network-signed assertion
 * (X-OV-Subject-Assertion): the signature, the audience, the service it was minted for and the person
 * it names. A forged, expired, replayed or wrong-audience assertion is refused; one that names another
 * person never moves money.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');

(async () => {
    console.log('subject assertions');
    // The flag off: the old way still works, and an assertion that comes is checked.
    const t = await boot();
    const fan = t.user(41);
    const creator = t.user(42);
    const other = t.user(43);
    await fund(t, fan, 10000);
    const tip = (o = {}) => t.call('POST', '/api/v1/transfers', { cap: ['billing.transfer.create'], body: { from: fan.id, to: creator.id, amount: 10, kind: 'donation' }, ...o });
    const assertion = (o = {}) => t.network.signAssertion({ subject: fan.id, act: 'svc:live', ...o });

    await check('without the flag, a money route that names a person still works the old way', async () => {
        const r = await tip();
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('without the flag, an assertion that names the person is accepted', async () => {
        const r = await tip({ headers: { 'x-ov-subject-assertion': assertion() } });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('an assertion that names another person is refused, and no money moves', async () => {
        const before = (await t.balances(fan.id)).credit;
        const r = await tip({ headers: { 'x-ov-subject-assertion': assertion({ subject: other.id }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'subject.assertion_mismatch');
        assert.strictEqual((await t.balances(fan.id)).credit, before, 'the money did not move');
    });

    await check('an assertion minted for another service is refused', async () => {
        const r = await tip({ headers: { 'x-ov-subject-assertion': assertion({ act: 'svc:vip' }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.actor_mismatch');
    });

    await check('without the flag, a forged assertion does not stop the money (the old way continues)', async () => {
        const r = await tip({ headers: { 'x-ov-subject-assertion': 'not.a.jwt' } });
        assert.strictEqual(r.status, 201, r.text);
    });

    // The flag on: the old way is refused.
    const t2 = await boot({ env: { BILLING_REQUIRE_SUBJECT_ASSERTION: 'on' } });
    const payer = t2.user(44);
    const payee = t2.user(45);
    await fund(t2, payer, 10000);
    const tip2 = (o = {}) => t2.call('POST', '/api/v1/transfers', { cap: ['billing.transfer.create'], body: { from: payer.id, to: payee.id, amount: 10, kind: 'donation' }, ...o });
    const assertion2 = (o = {}) => t2.network.signAssertion({ subject: payer.id, act: 'svc:live', ...o });

    await check('with the flag on, a money route without an assertion is refused', async () => {
        const r = await tip2();
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'subject.assertion_required');
    });

    await check('with the flag on, the person\'s own assertion lets the money through', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': assertion2() } });
        assert.strictEqual(r.status, 201, r.text);
    });

    await check('with the flag on, a forged assertion is refused', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': 'not.a.jwt' } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.malformed');
    });

    await check('with the flag on, an expired assertion is refused', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': assertion2({ expSec: -30 }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.expired');
    });

    await check('with the flag on, an assertion for another audience is refused', async () => {
        const r = await tip2({ headers: { 'x-ov-subject-assertion': assertion2({ audience: 'openvibe.tips' }) } });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'assertion.wrong_audience');
    });

    await check('with the flag on, a replayed assertion is refused the second time', async () => {
        const a = assertion2();
        const first = await tip2({ headers: { 'x-ov-subject-assertion': a } });
        assert.strictEqual(first.status, 201, first.text);
        const second = await tip2({ headers: { 'x-ov-subject-assertion': a } });
        assert.strictEqual(second.status, 403, second.text);
        assert.strictEqual(second.json.code, 'assertion.replayed');
    });

    await check('a balance read for a person is a per-person route too', async () => {
        const r = await t2.call('GET', `/api/v1/balances/${payer.id}`, { cap: ['billing.balance.read'] });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'subject.assertion_required');
        const ok = await t2.call('GET', `/api/v1/balances/${payer.id}`, { cap: ['billing.balance.read'], headers: { 'x-ov-subject-assertion': assertion2() } });
        assert.strictEqual(ok.status, 200, ok.text);
    });

    await done();
})().catch((err) => { console.error(err); process.exit(1); });
