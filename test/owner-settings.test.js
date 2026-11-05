'use strict';
/**
 * D11 owner settings: Billing's `billing.credits` namespace through openvibe-shared/config.
 *
 * The routes live at /internal/config behind Network's service token and `billing.config.manage`; the owner
 * is the X-OV-Subject usr_ id and a danger write needs X-OV-Fresh: 1. The env pins keep today's variables
 * winning; an owner change applies live to the Credits switches, the top-up terms and the hold lease.
 */
const assert = require('assert');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');

const CAP = ['billing.config.manage'];
const NAMESPACE = 'billing.credits';
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const KEK = 'k1:' + crypto.randomBytes(32).toString('base64');

(async () => {
    console.log('owner settings (billing.credits)');
    const t = await boot();
    const owner = t.user(301);
    t.network.addMembership(PRJ, owner.id, 'owner');
    const ownerToken = t.network.signUser({ subject_id: owner.id, username: 'owner' });
    const headers = (fresh = false, extra = {}) => ({ 'x-ov-subject': owner.id, ...(fresh ? { 'x-ov-fresh': '1' } : {}), ...extra });
    const get = (cap = CAP, extra = {}) => t.call('GET', '/internal/config', { cap, headers: extra });
    const apply = (values, { fresh = true, cap = CAP, merge = false } = {}) =>
        t.call('POST', `/internal/config/${NAMESPACE}`, { cap, headers: headers(fresh), body: { values, merge, reason: 'owner settings test' } });
    const rollback = (to, fresh = true) =>
        t.call('POST', `/internal/config/${NAMESPACE}/rollback`, { cap: CAP, headers: headers(fresh), body: { to, reason: 'owner settings test' } });
    const summary = async () => (await get()).json.namespaces[0];

    await check('the namespace and its schema are served, sealed:false with no KEK and no values until the owner sets them', async () => {
        const r = await get();
        assert.strictEqual(r.status, 200, r.text);
        const ns = r.json.namespaces[0];
        assert.strictEqual(ns.namespace, NAMESPACE);
        assert.strictEqual(ns.service, 'billing');
        assert.strictEqual(ns.revision, null);
        assert.strictEqual(ns.sealed, false);
        assert.strictEqual(ns.kek, null);
        const p = ns.schema.properties;
        assert.deepStrictEqual(Object.keys(p).sort(), ['credits', 'hold_lease_seconds', 'sandbox', 'topup', 'topup_amounts_cents', 'topup_fee_bps']);
        for (const k of Object.keys(p)) {
            assert.strictEqual(p[k]['x-group'], 'Balance', `${k}: x-group`);
            assert.ok(p[k].title && p[k].description, `${k}: title and description`);
        }
        assert.deepStrictEqual([p.credits['x-env'], p.credits['x-danger']], ['BILLING_CREDITS', true]);
        assert.deepStrictEqual([p.sandbox['x-env'], p.sandbox['x-danger']], ['BILLING_CREDITS_SANDBOX', undefined]);
        assert.deepStrictEqual([p.topup['x-env'], p.topup['x-danger']], ['BILLING_CREDITS_TOPUP', true]);
        assert.deepStrictEqual([p.topup_amounts_cents.type, p.topup_amounts_cents.items.type, p.topup_amounts_cents['x-env'], p.topup_amounts_cents['x-danger']], ['array', 'integer', 'BILLING_CREDITS_TOPUP_AMOUNTS_CENTS', true]);
        assert.deepStrictEqual([p.topup_fee_bps.minimum, p.topup_fee_bps.maximum, p.topup_fee_bps['x-danger']], [0, 10_000, true]);
        assert.strictEqual(p.hold_lease_seconds['x-env'], 'BILLING_INFERENCE_LEASE_SECONDS');
        // The brief's x-unit is "seconds"; Shared 4.110.0 only accepts nano_usd, ms and bps, so the unit is in the title.
        assert.strictEqual(p.hold_lease_seconds['x-unit'], undefined);
        assert.strictEqual(t.ctx.config.credits.enabled, false);
        const { topupTerms } = require('../server/ops/credits');
        assert.strictEqual(topupTerms(t.ctx).configured, false);
    });

    await check('a caller without billing.config.manage gets 403, and an unsigned one 401', async () => {
        const denied = await get(['billing.balance.read']);
        assert.strictEqual(denied.status, 403, denied.text);
        assert.strictEqual(denied.json.code, 'capability.denied');
        const missing = await t.call('GET', '/internal/config', { token: null });
        assert.strictEqual(missing.status, 401, missing.text);
        const write = await t.call('POST', `/internal/config/${NAMESPACE}`, { cap: ['billing.balance.read'], headers: headers(true), body: { values: { credits: true }, reason: 'x' } });
        assert.strictEqual(write.status, 403, write.text);
    });

    await check('a stale call to a danger key is 403 config.fresh_required and changes nothing', async () => {
        const r = await apply({ credits: true }, { fresh: false });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json.code, 'config.fresh_required');
        assert.strictEqual(t.ctx.config.credits.enabled, false);
    });

    await check('an owner change applies live and its audit line names the keys and actor, never a value', async () => {
        const r = await apply({ credits: true, topup: true, topup_amounts_cents: [1000, 2500], topup_fee_bps: 250 });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.revision, 1);
        assert.strictEqual(t.ctx.config.credits.enabled, true, 'the config object is updated without a restart');
        const { topupTerms } = require('../server/ops/credits');
        assert.deepStrictEqual(topupTerms(t.ctx), { enabled: true, amountsCents: [1000, 2500], feeBps: 250, configured: true, problem: null });
        const ns = await summary();
        assert.strictEqual(ns.revision, 1);
        assert.deepStrictEqual(ns.values.topup_amounts_cents, [1000, 2500]);
        const credit = await fetch(`${t.base}/api/me/credits?project_id=${PRJ}`, { headers: { Authorization: `Bearer ${ownerToken}` } });
        assert.strictEqual(credit.status, 200, await credit.text());
        const audit = await t.db.prepare("SELECT * FROM staff_audit WHERE action = 'config.change' ORDER BY seq DESC LIMIT 1").get();
        assert.ok(audit, 'no audit line');
        assert.strictEqual(audit.actor_subject, owner.id);
        assert.strictEqual(audit.target_id, NAMESPACE);
        const detail = JSON.parse(audit.detail);
        assert.strictEqual(detail.service, 'billing');
        assert.strictEqual(detail.namespace, NAMESPACE);
        assert.strictEqual(detail.revision, 1);
        assert.deepStrictEqual([...detail.keys].sort(), ['credits', 'topup', 'topup_amounts_cents', 'topup_fee_bps']);
        assert.ok(!audit.detail.includes('250') && !audit.detail.includes('1000'), 'the audit line must not carry a value');
    });

    await check('a non-danger key needs no fresh sign-in, a danger key does', async () => {
        const lease = await apply({ hold_lease_seconds: 120 }, { fresh: false, merge: true });
        assert.strictEqual(lease.status, 200, lease.text);
        assert.strictEqual(t.ctx.config.credits.leaseSeconds, 120);
        const stale = await apply({ topup_fee_bps: 300 }, { fresh: false, merge: true });
        assert.strictEqual(stale.status, 403, stale.text);
        assert.strictEqual(stale.json.code, 'config.fresh_required');
        assert.strictEqual((await apply({ topup_fee_bps: 300 }, { merge: true })).status, 200);
        assert.strictEqual(require('../server/ops/credits').topupTerms(t.ctx).feeBps, 300);
    });

    await check('history and a rollback apply the earlier terms live', async () => {
        const before = require('../server/ops/credits').topupTerms(t.ctx).feeBps;
        await apply({ topup_fee_bps: 400 }, { merge: true });
        assert.strictEqual(require('../server/ops/credits').topupTerms(t.ctx).feeBps, 400);
        const h = await t.call('GET', `/internal/config/${NAMESPACE}/history`, { cap: CAP });
        assert.strictEqual(h.status, 200, h.text);
        const target = h.json.snapshots.find((s) => s.values && s.values.topup_fee_bps === before && s.state !== 'active');
        assert.ok(target, 'no earlier revision with the old fee');
        const back = await rollback(target.revision);
        assert.strictEqual(back.status, 200, back.text);
        assert.strictEqual(require('../server/ops/credits').topupTerms(t.ctx).feeBps, before);
    });

    await check('the env pins win and an owner write to a pinned key is 409 config.pinned_in_env', async () => {
        const pinned = await boot({
            env: {
                BILLING_CREDITS: '1', BILLING_CREDITS_TOPUP: '1',
                BILLING_CREDITS_TOPUP_AMOUNTS_CENTS: '1000, 2500', BILLING_CREDITS_TOPUP_FEE_BPS: '250', BILLING_INFERENCE_LEASE_SECONDS: '600',
            },
        });
        try {
            const o = pinned.user(302);
            const h = (fresh) => ({ 'x-ov-subject': o.id, ...(fresh ? { 'x-ov-fresh': '1' } : {}) });
            const ns = (await pinned.call('GET', '/internal/config', { cap: CAP })).json.namespaces[0];
            assert.strictEqual(ns.values.credits, true);
            assert.strictEqual(ns.values.topup, true);
            assert.deepStrictEqual(ns.values.topup_amounts_cents, [1000, 2500]);
            assert.strictEqual(ns.values.topup_fee_bps, 250);
            assert.strictEqual(ns.values.hold_lease_seconds, 600);
            assert.deepStrictEqual(ns.pins.topup, { env: 'BILLING_CREDITS_TOPUP', pinned: true });
            const terms = require('../server/ops/credits').topupTerms(pinned.ctx);
            assert.deepStrictEqual([terms.enabled, terms.amountsCents, terms.feeBps, terms.configured], [true, [1000, 2500], 250, true]);
            const r = await pinned.call('POST', `/internal/config/${NAMESPACE}`, { cap: CAP, headers: h(true), body: { values: { topup: false }, reason: 'x' } });
            assert.strictEqual(r.status, 409, r.text);
            assert.strictEqual(r.json.code, 'config.pinned_in_env');
            const lease = await pinned.call('POST', `/internal/config/${NAMESPACE}`, { cap: CAP, headers: h(true), body: { values: { hold_lease_seconds: 120 }, reason: 'x' } });
            assert.strictEqual(lease.status, 409, lease.text);
            assert.strictEqual(pinned.ctx.config.credits.leaseSeconds, 600);
        } finally { await pinned.close(); }
    });

    await check('the old boolean forms still pin, and an empty variable means unset so the owner can set it', async () => {
        const legacy = await boot({ env: { BILLING_CREDITS: 'yes', BILLING_CREDITS_SANDBOX: '' } });
        try {
            const o = legacy.user(303);
            const h = { 'x-ov-subject': o.id, 'x-ov-fresh': '1' };
            const ns = (await legacy.call('GET', '/internal/config', { cap: CAP })).json.namespaces[0];
            assert.strictEqual(ns.values.credits, true);
            assert.ok(ns.pins.credits && ns.pins.credits.pinned === true);
            assert.strictEqual(ns.pins.sandbox, undefined, 'an empty env variable is unset, not a pin');
            const r = await legacy.call('POST', `/internal/config/${NAMESPACE}`, { cap: CAP, headers: h, body: { values: { sandbox: true }, merge: true, reason: 'x' } });
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(legacy.ctx.config.credits.sandbox, true);
        } finally { await legacy.close(); }
    });

    await check('a secret route is write-only and this namespace has no secret keys: 422, and no value is echoed', async () => {
        const r = await t.call('PUT', `/internal/config/${NAMESPACE}/secrets/topup_fee_bps`, { cap: CAP, headers: headers(true), body: { value: 777, reason: 'x' } });
        assert.strictEqual(r.status, 422, r.text);
        assert.strictEqual(r.json.code, 'config.not_secret');
        assert.ok(!r.text.includes('777'));
        assert.ok(!t.logs.join('\n').includes('777'), 'a refused secret must not reach a log line');
        const ns = await summary();
        assert.notStrictEqual(ns.values.topup_fee_bps, 777);
        assert.ok(!JSON.stringify(ns.secrets || {}).includes('777'));
    });

    await check('with a KEK the namespace reports sealed:true and reseals without breaking', async () => {
        const sealed = await boot({ env: { OV_CONFIG_KEKS: KEK, OV_CONFIG_KEK_CURRENT: 'k1' } });
        try {
            const ns = (await sealed.call('GET', '/internal/config', { cap: CAP })).json.namespaces[0];
            assert.strictEqual(ns.sealed, true);
            assert.strictEqual(ns.kek, 'k1');
            assert.strictEqual(sealed.ctx.configStore.sealed, true);
            const report = await sealed.ctx.configStore.reseal();
            assert.strictEqual(report.kek, 'k1');
            assert.deepStrictEqual(report.errors, []);
        } finally { await sealed.close(); }
    });

    await t.close();
    done();
})();
