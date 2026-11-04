'use strict';
/**
 * Vibes Pay (D12 step 4): app charges, the pay sheet, the project wallet, signed webhooks, refunds, limits,
 * sandbox Vibes and the journal. Money is whole Vibes; a charge moves once and never below zero.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { boot, fund, check, done } = require('./helpers/app');
const { validate } = require('openvibe-contracts');
const vibesWebhooks = require('../server/ops/vibes-webhooks');

const APP = 'app_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const APP2 = 'app_01JAB2C3D4E5F6G7H8J9K0MNP2';
const PRJ = 'prj_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const PRJ2 = 'prj_01JAB2C3D4E5F6G7H8J9K0MNP2';
const KEK = 'k1:' + crypto.randomBytes(32).toString('base64');
const CAP = ['billing.vibes.charge', 'billing.vibes.read'];

function startHook() {
    const received = [];
    const state = { failStatus: 0 };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            if (state.failStatus) { res.writeHead(state.failStatus); res.end('no'); return; }
            received.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}/hook`, received, state,
        close: () => new Promise((r) => server.close(r)),
    })));
}

function signatureOk(raw, header, secret) {
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
    if (!/^\d{1,12}$/.test(String(parts.t || '')) || !/^[0-9a-f]{64}$/i.test(String(parts.v2 || ''))) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.`).update(raw).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(parts.v2, 'hex'), Buffer.from(expected, 'hex'));
}

async function journalBalanced(db, label) {
    const rows = await db.prepare(`SELECT a.currency, SUM(e.amount)::text AS total FROM ledger_entries e
        JOIN accounts a ON a.id = e.account_id GROUP BY a.currency`).all();
    for (const r of rows) assert.strictEqual(String(r.total), '0', `journal not balanced for ${r.currency} ${label}: ${r.total}`);
}

(async () => {
    console.log('Vibes Pay');
    const hook = await startHook();
    const t = await boot({
        env: {
            BILLING_AUTHORITY: 'billing',
            BILLING_VIBES_PAY: '1',
            BILLING_VIBES_MAX_CHARGE: '10000',
            BILLING_VIBES_DAILY_APP_SPEND: '10000',
            BILLING_VIBES_SANDBOX: '1',
            BILLING_VIBES_CHARGE_TTL_SECONDS: '1800',
            OV_CONFIG_KEKS: KEK, OV_CONFIG_KEK_CURRENT: 'k1',
        },
    });
    try {
        const payer = t.user(401);
        const other = t.user(402);
        t.network.addProject({ id: PRJ, name: 'Neon Studio', owner: payer.id });
        t.network.addProject({ id: PRJ2, name: 'Sandbox Studio', owner: payer.id });
        t.network.addMembership(PRJ, payer.id, 'owner', false, 'Neon Studio');
        t.network.addApp({ id: APP, projectId: PRJ, name: 'Neon Cats', environment: 'production', icon: 'https://openvibe.media/assets/neon.png' });
        t.network.addApp({ id: APP2, projectId: PRJ2, name: 'Sandbox Cats', environment: 'sandbox' });
        const appToken = t.network.signApp({ appId: APP, projectId: PRJ, env: 'production', cap: CAP });
        const app2Token = t.network.signApp({ appId: APP2, projectId: PRJ2, env: 'sandbox', cap: CAP });
        const payerToken = t.network.signUser({ subject_id: payer.id, username: 'payer' });
        const otherToken = t.network.signUser({ subject_id: other.id, username: 'other' });
        await fund(t, payer, 1000);
        const appHeaders = (token = appToken) => ({ token });
        const create = (body, token = appToken) => t.call('POST', '/api/v1/vibes/charges', { token, body });
        const charge = async (body, token = appToken) => {
            const r = await create(body, token);
            assert.strictEqual(r.status, 201, r.text);
            return r.json;
        };
        const pay = (id, token = payerToken, key = `pay_${crypto.randomBytes(8).toString('hex')}`) =>
            t.call('POST', `/api/me/vibes/charges/${id}/pay`, { token, body: { idempotency_key: key }, key: null });
        const cancel = (id, token = payerToken) => t.call('POST', `/api/me/vibes/charges/${id}/cancel`, { token, body: {}, key: null });
        const viewOf = async (id, token = payerToken) => await t.call('GET', `/api/me/vibes/charges/${id}`, { token });
        const balanceOf = async (account) => Number(String((await t.db.prepare(`SELECT COALESCE(b.balance, 0)::text AS b FROM accounts a
            LEFT JOIN account_balances b ON b.account_id = a.id WHERE a.kind = ? AND a.owner_subject IS NOT DISTINCT FROM ? AND a.currency = ?`).get(account.kind, account.owner, account.currency)).b));
        const payerAcct = { kind: 'user_credit', owner: payer.id, currency: 'vibes-bits' };
        const projectAcct = { kind: 'project_payable', owner: `project:${PRJ}`, currency: 'vibes-bits' };

        let secret;
        await check('the app stores its webhook url and a sealed secret; the marker is all a read returns', async () => {
            const put = await t.call('PUT', '/api/v1/vibes/webhook', { token: appToken, body: { url: hook.url } });
            assert.strictEqual(put.status, 200, put.text);
            assert.strictEqual(put.json.sealed, true);
            assert.strictEqual(put.json.secret_set, true);
            assert.ok(put.json.shown_once && typeof put.json.secret === 'string' && put.json.secret.length >= 16, put.text);
            secret = put.json.secret;
            const get = await t.call('GET', '/api/v1/vibes/webhook', { token: appToken });
            assert.strictEqual(get.status, 200, get.text);
            assert.strictEqual(get.json.secret, undefined, 'a read never returns the secret');
            assert.strictEqual(get.json.secret_hint, secret.slice(-4));
            assert.strictEqual(get.json.url, hook.url);
            const row = await t.db.prepare("SELECT values_json FROM config_snapshots WHERE namespace = ? ORDER BY revision DESC LIMIT 1").get(`billing.app.${APP.toLowerCase()}`);
            assert.ok(row, 'the app webhook has a D11 revision');
            assert.ok(!String(row.values_json).includes(secret), 'the sealed store carries no plaintext secret');
            const otherApp = await t.call('GET', '/api/v1/vibes/webhook', { token: app2Token });
            assert.strictEqual(otherApp.status, 200, otherApp.text);
            assert.strictEqual(otherApp.json.url, null, 'another app sees its own empty settings');
        });

        let paidCharge;
        await check('create is idempotent on the app reference, and a different body under it conflicts', async () => {
            const body = { amount: 50, description: 'Sticker pack: Neon cats', reference: 'order_123', return_url: 'https://myapp.example/thanks' };
            const r = await create(body);
            assert.strictEqual(r.status, 201, r.text);
            paidCharge = r.json;
            const valid = validate('billing.vibes-charge@1', paidCharge);
            assert.ok(valid.valid, JSON.stringify(valid.errors));
            assert.strictEqual(paidCharge.status, 'pending');
            assert.match(paidCharge.pay_url, /^https:\/\/openvibe\.network\/pay\/vch_[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.strictEqual(paidCharge.sandbox, false);
            const replay = await create(body);
            assert.strictEqual(replay.status, 200, replay.text);
            assert.strictEqual(replay.json.id, paidCharge.id);
            const conflict = await create({ ...body, amount: 51 });
            assert.strictEqual(conflict.status, 409, conflict.text);
            assert.strictEqual(conflict.json.code, 'billing.reference_reused');
            const notMine = await t.call('GET', `/api/v1/vibes/charges/${paidCharge.id}`, { token: app2Token });
            assert.strictEqual(notMine.status, 404, notMine.text);
        });

        await check('the pay sheet shows the app from Network, the item, the price and the person\'s Vibes', async () => {
            const r = await viewOf(paidCharge.id);
            assert.strictEqual(r.status, 200, r.text);
            assert.ok(validate('billing.vibes-charge@1', r.json.charge).valid);
            assert.deepStrictEqual(r.json.app, { id: APP, name: 'Neon Cats', icon: 'https://openvibe.media/assets/neon.png' });
            assert.strictEqual(r.json.charge.description, 'Sticker pack: Neon cats');
            assert.strictEqual(r.json.vibes_credit, 1000);
            assert.strictEqual(r.json.shortfall_vibes, 0);
            assert.strictEqual(r.json.can_pay, true);
            assert.strictEqual((await t.call('GET', `/api/me/vibes/charges/${paidCharge.id}`)).status, 401);
            assert.strictEqual((await t.call('GET', '/api/me/vibes/charges/vch_01JAB2C3D4E5F6G7H8J9K0MNPQ')).status, 401);
            const cors = await fetch(`${t.base}/api/me/vibes/charges/${paidCharge.id}`, { headers: { Authorization: `Bearer ${payerToken}`, Origin: 'https://openvibe.network' } });
            assert.strictEqual(cors.status, 200);
            assert.strictEqual(cors.headers.get('access-control-allow-origin'), 'https://openvibe.network');
            assert.strictEqual(cors.headers.get('cache-control'), 'private, no-store');
        });

        await check('a person-delegated app reads only that person\'s Vibes (billing.vibes.read)', async () => {
            const delegated = t.network.signApp({ appId: APP, projectId: PRJ, env: 'production', cap: ['billing.vibes.read'], onBehalfOf: payer.id });
            const r = await t.call('GET', '/api/v1/vibes/me', { token: delegated });
            assert.strictEqual(r.status, 200, r.text);
            assert.ok(validate('billing.vibes-wallet@1', r.json).valid, JSON.stringify(r.json));
            assert.deepStrictEqual(r.json.subject, { type: 'user', id: payer.id });
            assert.strictEqual(r.json.credit, 1000);
            const noPerson = t.network.signApp({ appId: APP, projectId: PRJ, env: 'production', cap: ['billing.vibes.read'] });
            assert.strictEqual((await t.call('GET', '/api/v1/vibes/me', { token: noPerson })).status, 422);
            const sandbox = t.network.signApp({ appId: APP2, projectId: PRJ2, env: 'sandbox', cap: ['billing.vibes.read'], onBehalfOf: payer.id });
            const refused = await t.call('GET', '/api/v1/vibes/me', { token: sandbox });
            assert.strictEqual(refused.status, 403, refused.text);
            assert.strictEqual(refused.json.code, 'billing.sandbox_refused');
        });

        await check('the person pays once, atomically: 50 Vibes move to the project wallet', async () => {
            const r = await pay(paidCharge.id, payerToken, `pay_first_${crypto.randomBytes(8).toString('hex')}`);
            assert.strictEqual(r.status, 200, r.text);
            assert.strictEqual(r.json.charge.status, 'paid');
            assert.ok(r.json.charge.paid_at);
            assert.strictEqual(r.json.vibes_credit, 950);
            assert.strictEqual(await balanceOf(payerAcct), 950);
            assert.strictEqual(await balanceOf(projectAcct), 50);
            const rows = await t.db.prepare("SELECT id FROM transactions WHERE type = 'vibes_charge'").all();
            assert.strictEqual(rows.length, 1);
            await journalBalanced(t.db, 'after a payment');
        });

        await check('the app gets a signed paid webhook with no person id or email, and the event too', async () => {
            const out = await vibesWebhooks.deliverDue(t.ctx);
            assert.strictEqual(out.delivered, 1, JSON.stringify(out));
            assert.strictEqual(hook.received.length, 1);
            const delivery = hook.received[0];
            assert.ok(signatureOk(delivery.raw, delivery.headers['x-openvibe-signature-v2'], secret), 'the HMAC-SHA256 signature verifies');
            assert.strictEqual(delivery.headers['x-openvibe-event'], 'billing.vibes.charge.paid');
            const body = JSON.parse(delivery.raw);
            const valid = validate('billing.vibes.charge.paid@1', body);
            assert.ok(valid.valid, JSON.stringify(valid.errors));
            assert.strictEqual(body.status, 'paid');
            assert.strictEqual(body.amount, 50);
            assert.match(body.payer_ref, /^pr_[0-9a-f]{32}$/);
            assert.ok(!delivery.raw.includes(payer.id), 'no person id in the webhook');
            assert.ok(!delivery.raw.includes('usr_'), 'no subject id in the webhook');
            assert.ok(!delivery.raw.includes('@'), 'no email in the webhook');
            const ev = await t.db.prepare("SELECT envelope FROM service_outbox WHERE envelope #>> '{event_type}' = 'billing.vibes.charge.paid'").get();
            assert.ok(ev, 'the first-party event is in the outbox');
            const envelope = typeof ev.envelope === 'string' ? JSON.parse(ev.envelope) : ev.envelope;
            assert.strictEqual(envelope.payload.payer_ref, body.payer_ref);
            assert.ok(!JSON.stringify(envelope).includes(payer.id));
        });

        await check('a double pay pays once: a replay for the same person, a conflict for another', async () => {
            const same = await pay(paidCharge.id, payerToken, `pay_second_${crypto.randomBytes(8).toString('hex')}`);
            assert.strictEqual(same.status, 200, same.text);
            assert.strictEqual(same.json.replay, true);
            assert.strictEqual(same.json.charge.status, 'paid');
            const count = await t.db.prepare("SELECT COUNT(*)::int AS n FROM transactions WHERE type = 'vibes_charge'").get();
            assert.strictEqual(count.n, 1);
            assert.strictEqual(await balanceOf(payerAcct), 950);
            assert.strictEqual(await balanceOf(projectAcct), 50);
            const rival = await pay(paidCharge.id, otherToken);
            assert.strictEqual(rival.status, 409, rival.text);
            assert.strictEqual(rival.json.code, 'billing.charge_not_pending');
            assert.strictEqual((await cancel(paidCharge.id)).status, 409);
        });

        await check('a refund returns the Vibes once, from the project wallet, and emits the refunded webhook', async () => {
            const r = await t.call('POST', `/api/v1/vibes/charges/${paidCharge.id}/refund`, { token: appToken, body: { reason: 'bought twice' }, key: null });
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json.status, 'refunded');
            assert.ok(r.json.refunded_at);
            assert.strictEqual(await balanceOf(payerAcct), 1000);
            assert.strictEqual(await balanceOf(projectAcct), 0);
            const again = await t.call('POST', `/api/v1/vibes/charges/${paidCharge.id}/refund`, { token: appToken, body: {}, key: null });
            assert.strictEqual(again.status, 200, again.text);
            assert.strictEqual(again.json.status, 'refunded');
            const refunds = await t.db.prepare("SELECT COUNT(*)::int AS n FROM transactions WHERE type = 'vibes_refund'").get();
            assert.strictEqual(refunds.n, 1);
            const out = await vibesWebhooks.deliverDue(t.ctx);
            assert.strictEqual(out.delivered, 1, JSON.stringify(out));
            const delivery = hook.received[hook.received.length - 1];
            assert.ok(signatureOk(delivery.raw, delivery.headers['x-openvibe-signature-v2'], secret));
            const body = JSON.parse(delivery.raw);
            assert.ok(validate('billing.vibes.charge.refunded@1', body).valid);
            assert.strictEqual(body.status, 'refunded');
            assert.strictEqual(body.payer_ref, JSON.parse(hook.received[0].raw).payer_ref, 'the payer reference is stable per app');
            assert.ok(!delivery.raw.includes(payer.id));
            await journalBalanced(t.db, 'after a refund');
        });

        await check('an expired charge cannot be paid and never moves money', async () => {
            const c = await charge({ amount: 10, description: 'Late sticker', reference: 'order_expired' });
            t.clock.offset += 31 * 60 * 1000;
            const r = await pay(c.id);
            assert.strictEqual(r.status, 409, r.text);
            assert.strictEqual(r.json.code, 'billing.charge_expired');
            const row = await t.db.prepare('SELECT status FROM vibes_charges WHERE id = ?').get(c.id);
            assert.strictEqual(row.status, 'expired');
            const count = await t.db.prepare("SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = ?").get(`vibes:charge:${c.id}`);
            assert.strictEqual(count.n, 0);
        });

        await check('short of Vibes is 402 and the charge stays pending', async () => {
            const c = await charge({ amount: 1001, description: 'Too much', reference: 'order_short' });
            const r = await pay(c.id);
            assert.strictEqual(r.status, 402, r.text);
            assert.strictEqual(r.json.code, 'billing.insufficient_vibes');
            assert.strictEqual(r.json.details.required, 1001);
            const row = await t.db.prepare('SELECT status FROM vibes_charges WHERE id = ?').get(c.id);
            assert.strictEqual(row.status, 'pending');
        });

        await check('limit: the largest single charge and the daily app spend are owner settings', async () => {
            const tooBig = await create({ amount: 10001, description: 'Over the top', reference: 'order_big' });
            assert.strictEqual(tooBig.status, 403, tooBig.text);
            assert.strictEqual(tooBig.json.code, 'billing.vibes_limit_exceeded');
            await fund(t, payer, 20000);
            // The boot caps the day at 10,000; spend it with one allowed charge, then a little one is refused.
            const big = await charge({ amount: 10000, description: 'One big one', reference: 'order_big_ok' });
            assert.strictEqual((await pay(big.id)).status, 200);
            const little = await charge({ amount: 1, description: 'One more', reference: 'order_over_daily' });
            const r = await pay(little.id);
            assert.strictEqual(r.status, 403, r.text);
            assert.strictEqual(r.json.code, 'billing.vibes_limit_exceeded');
            // Paying a big allowed charge back leaves the daily spend net of the refund.
            const refund = await t.call('POST', `/api/v1/vibes/charges/${big.id}/refund`, { token: appToken, body: {}, key: null });
            assert.strictEqual(refund.status, 201, refund.text);
        });

        await check('a webhook that fails is retried with backoff and delivered later', async () => {
            await vibesWebhooks.deliverDue(t.ctx);   // drain earlier deliveries so this check sees only its own row
            hook.state.failStatus = 500;
            const c = await charge({ amount: 5, description: 'Retry me', reference: 'order_retry' });
            assert.strictEqual((await pay(c.id)).status, 200);
            const first = await vibesWebhooks.deliverDue(t.ctx);
            assert.strictEqual(first.failed, 1, JSON.stringify(first));
            const row = await t.db.prepare('SELECT * FROM vibes_webhook_outbox WHERE charge_id = ?').get(c.id);
            assert.strictEqual(Number(row.attempts), 1);
            assert.strictEqual(Number(row.last_status), 500);
            assert.ok(row.delivered_at == null);
            assert.ok(new Date(row.next_attempt_at).getTime() > t.ctx.now(), 'the retry is scheduled in the future');
            hook.state.failStatus = 0;
            await t.db.prepare('UPDATE vibes_webhook_outbox SET next_attempt_at = ?::timestamptz WHERE charge_id = ?').run(new Date(t.ctx.now() - 1000).toISOString(), c.id);
            const second = await vibesWebhooks.deliverDue(t.ctx);
            assert.strictEqual(second.delivered, 1, JSON.stringify(second));
            const done = await t.db.prepare('SELECT * FROM vibes_webhook_outbox WHERE charge_id = ?').get(c.id);
            assert.ok(done.delivered_at);
            assert.strictEqual(Number(done.attempts), 2);
        });

        await check('the project owner cashes out the project wallet through the existing cashout path', async () => {
            const c = await charge({ amount: 500, description: 'Cashout item', reference: 'order_cashout' });
            assert.strictEqual((await pay(c.id)).status, 200);
            const before = await balanceOf(projectAcct);
            const request = (body, cap = ['billing.cashout.request'], key) => t.call('POST', '/api/v1/cashouts', { cap, body, ...(key ? { key } : {}) });
            const body = {
                subject: payer.id, project_id: PRJ, amount: 500,
                payout_method: { type: 'paypal', address: 'payer@example.com' },
            };
            const r = await request(body);
            assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(r.json.cashout.project_id, PRJ, 'the cashout names the project');
            assert.strictEqual(await balanceOf(projectAcct), before - 500);
            const pending = Number((await t.db.prepare(`SELECT b.balance::text AS b FROM accounts a JOIN account_balances b ON b.account_id = a.id
                WHERE a.kind = 'payouts_pending' AND a.owner_subject = ?`).get(payer.id)).b);
            assert.strictEqual(pending, 500);
            const otherBody = { ...body, subject: other.id };
            const denied = await request(otherBody);
            assert.strictEqual(denied.status, 403, denied.text);
            assert.strictEqual(denied.json.code, 'billing.not_project_owner');
            await journalBalanced(t.db, 'after a project cashout');
        });

        await check('the economy freeze refuses app charges and payments, reads still answer', async () => {
            const c = await charge({ amount: 5, description: 'Before freeze', reference: 'order_before_freeze' });
            await t.call('POST', '/api/v1/admin/freeze', { key: null, body: { on: true, reason: 'Vibes Pay test' } });
            const frozen = await create({ amount: 5, description: 'Frozen', reference: 'order_frozen' });
            assert.strictEqual(frozen.status, 503, frozen.text);
            assert.strictEqual(frozen.json.code, 'billing.frozen');
            const r = await pay(c.id);
            assert.strictEqual(r.status, 503, r.text);
            assert.strictEqual(r.json.code, 'billing.frozen');
            assert.strictEqual((await viewOf(c.id)).status, 200);
            await t.call('POST', '/api/v1/admin/freeze', { key: null, body: { on: false } });
        });

        await check('sandbox: test grants only, test Vibes only, never a real account', async () => {
            const realBefore = await balanceOf(payerAcct);
            const projectBefore = await balanceOf(projectAcct);
            const c = await charge({ amount: 30, description: 'Sandbox sticker', reference: 'sandbox_1' }, app2Token);
            assert.strictEqual(c.sandbox, true);
            const short = await pay(c.id);
            assert.strictEqual(short.status, 402, short.text);
            const grant = await t.call('POST', '/api/v1/vibes/sandbox/grants', {
                token: app2Token, body: { subject: { type: 'user', id: payer.id }, amount: 100 }, key: null,
            });
            assert.strictEqual(grant.status, 201, grant.text);
            assert.strictEqual(grant.json.vibes_credit, 100);
            const view = await viewOf(c.id);
            assert.strictEqual(view.json.vibes_credit, 100);
            assert.strictEqual(view.json.can_pay, true);
            const paid = await pay(c.id);
            assert.strictEqual(paid.status, 200, paid.text);
            assert.strictEqual(paid.json.charge.status, 'paid');
            assert.strictEqual(paid.json.vibes_credit, 70);
            assert.strictEqual(await balanceOf(payerAcct), realBefore, 'real Vibes were not touched');
            assert.strictEqual(await balanceOf(projectAcct), projectBefore, 'the real project wallet was not touched');
            const row = await t.db.prepare(`SELECT t.test, a.kind, b.balance::text AS balance FROM transactions t
                JOIN ledger_entries e ON e.txn_id = t.id JOIN accounts a ON a.id = e.account_id JOIN account_balances b ON b.account_id = a.id
                WHERE t.idempotency_key = ? AND a.kind = 'project_payable_sandbox'`).get(`vibes:charge:${c.id}`);
            assert.ok(row && Number(row.test) === 1 && row.balance === '30', JSON.stringify(row));
            // A production app cannot mint sandbox Vibes.
            const refused = await t.call('POST', '/api/v1/vibes/sandbox/grants', { token: appToken, body: { subject: { type: 'user', id: payer.id }, amount: 10 }, key: null });
            assert.strictEqual(refused.status, 403, refused.text);
            assert.strictEqual(refused.json.code, 'billing.sandbox_app_only');
            // A person with only sandbox Vibes cannot pay a real charge.
            const onlySandbox = t.user(403);
            const onlyToken = t.network.signUser({ subject_id: onlySandbox.id, username: 'sandbox' });
            await t.call('POST', '/api/v1/vibes/sandbox/grants', { token: app2Token, body: { subject: { type: 'user', id: onlySandbox.id }, amount: 500 }, key: null });
            const real = await charge({ amount: 10, description: 'Real item', reference: 'real_after_sandbox' });
            const denied = await pay(real.id, onlyToken);
            assert.strictEqual(denied.status, 402, denied.text);
            // A sandbox refund returns test Vibes to the test pocket.
            const refund = await t.call('POST', `/api/v1/vibes/charges/${c.id}/refund`, { token: app2Token, body: {}, key: null });
            assert.strictEqual(refund.status, 201, refund.text);
            const after = await t.call('GET', '/api/v1/vibes/charges/' + c.id, { token: app2Token });
            assert.strictEqual(after.json.status, 'refunded');
        });

        await check('every journal transaction balances and reconciliation passes', async () => {
            await journalBalanced(t.db, 'at the end');
            const rec = await t.assertReconciled('after Vibes Pay');
            assert.ok(rec.ok);
        });
    } finally {
        await hook.close();
        await t.close();
    }
    done();
})();
