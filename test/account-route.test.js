'use strict';
/**
 * POST /internal/events end to end: a delivery signed the way OpenVibe.Events signs it (X-OpenVibe-Signature-V2 over the
 * raw body) is applied; another secret is refused. Guards the raw body reaching the consumer unparsed.
 */
const assert = require('assert');
const crypto = require('crypto');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/app');

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from(crypto.randomBytes(26), (b) => CROCKFORD[b % 32]).join('');

(async () => {
    const secret = crypto.randomBytes(32).toString('hex');
    const parts = [];
    const send = async (path, body) => { parts.push({ path, body }); return { ok: true, status: 201, json: async () => ({}), text: async () => '' }; };
    const t = await boot({ env: { BILLING_EVENTS_SECRET: secret }, accountSend: send });
    const fan = t.user(81);
    const post = (raw, key) => fetch(`${t.base}/internal/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(raw, key) }, body: raw });

    await check('a signed export request is applied; another secret is refused', async () => {
        // Events delivers { event, seq }.
        const raw = JSON.stringify({ seq: 1, event: { event_id: `evt_${ulid()}`, event_type: 'network.account.export_requested', source: 'network', version: 1, timestamp: new Date().toISOString(), actor: { type: 'service', id: 'network' }, subject: { type: 'account', id: fan.id }, visibility: 'internal', payload: { export_id: `exp_${ulid()}`, subject: fan.id } } });
        assert.strictEqual((await post(raw, 'x'.repeat(64))).status, 401);
        const r = await post(raw, secret);
        const text = await r.text();
        assert.strictEqual(r.status, 200, text);
        assert.strictEqual(JSON.parse(text).outcome, 'exported');
        assert.strictEqual(parts.length, 1);
        assert.match(parts[0].path, /\/internal\/account-exports\/exp_[0-9A-Z]{26}\/parts$/);
    });

    await t.close();
    done();
})();
