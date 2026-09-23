'use strict';
/**
 * The staff console: Network SSO with PKCE, staff-only access (Network role admin AND listed in
 * BILLING_STAFF_SUBJECTS), session cookie attributes, CSRF on every form, cashout approve/deny
 * through ops/cashouts with the payout reference and escrow enforced, the freeze, reconciliation,
 * review queue — every action audited once in staff_audit and announced as billing.staff.action —
 * and no secrets or provider payloads on any page.
 */
const assert = require('assert');
const { boot, fund, check, done } = require('./helpers/app');
const { startNetwork } = require('./helpers/stubs');

const SESSION_SECRET = 'console-test-secret-0123456789abcdef-0123456789';
const DAY = 86_400_000;

(async () => {
    const network = await startNetwork();
    const staff = network.addUser();          // admin + listed
    const listedNonAdmin = network.addUser(); // listed, but Network role 'user'
    const unlistedAdmin = network.addUser();  // Network admin, not Billing staff
    const t = await boot({ network, env: { BASE_URL: 'https://billing.test', BILLING_STAFF_SUBJECTS: `${staff}, ${listedNonAdmin}, not-a-subject`, BILLING_SESSION_SECRET: SESSION_SECRET } });
    const fan = t.user(21);
    const creator = t.user(22);
    console.log('staff console');

    const setCookies = (res) => (res.headers.getSetCookie ? res.headers.getSetCookie() : []);
    async function get(path, cookie, headers = {}) {
        const res = await fetch(t.base + path, { redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
        return { status: res.status, headers: res.headers, text: await res.text(), cookies: setCookies(res) };
    }
    async function post(path, cookie, form, headers = {}) {
        const res = await fetch(t.base + path, {
            method: 'POST', redirect: 'manual',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}), ...headers },
            body: new URLSearchParams(form).toString(),
        });
        return { status: res.status, headers: res.headers, text: await res.text(), cookies: setCookies(res) };
    }
    async function signIn(subject, { role = 'admin', username = 'staffer', next = '/cashouts' } = {}) {
        const login = await get(`/auth/login?next=${encodeURIComponent(next)}`);
        assert.strictEqual(login.status, 302);
        const loc = new URL(login.headers.get('location'));
        const flow = login.cookies.find((c) => c.startsWith('ovb_flow='));
        const code = network.authorize({
            subject_id: subject, role, username, challenge: loc.searchParams.get('code_challenge'),
            redirect_uri: loc.searchParams.get('redirect_uri'), nowMs: Date.now() + t.clock.offset,
        });
        const cb = await get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, flow.split(';')[0]);
        const sess = cb.cookies.find((c) => c.startsWith('__Host-ovb_staff=') && !c.startsWith('__Host-ovb_staff=;'));
        return { cb, loc, flow, setCookie: sess || null, cookie: sess ? sess.split(';')[0] : null };
    }
    const csrfOf = (page) => (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const keyOf = (page, action) => (page.text.match(new RegExp(`action="${action}"><input type="hidden" name="_csrf" value="[^"]+"><input type="hidden" name="action_key" value="([^"]+)"`)) || [])[1];
    const auditRows = (action, outcome = 'done') => t.db.prepare('SELECT * FROM staff_audit WHERE action = ? AND outcome = ?').all(action, outcome);
    const staffEvents = (action) => t.db.prepare("SELECT event FROM outbox WHERE json_extract(event, '$.event_type') = 'billing.staff.action' AND json_extract(event, '$.payload.action') = ?").all(action).map((r) => JSON.parse(r.event));
    async function newCashout(amount = 600) {
        const r = await t.call('POST', '/api/v1/cashouts', { body: { subject: creator, amount, payout_method: { type: 'paypal', address: 'creator@example.com' } } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json.cashout.id;
    }

    // Money for the cashouts: the fan buys credit and tips the creator (creator payable).
    await fund(t, fan, 5000);
    const tip = await t.call('POST', '/api/v1/transfers', { body: { from: fan, to: creator, amount: 3000 } });
    assert.strictEqual(tip.status, 201, tip.text);

    let s;   // the staff session cookie

    await check('sign-in redirects to the Network with PKCE S256 and a signed, host-only flow cookie', async () => {
        const login = await get('/auth/login?next=/cashouts');
        assert.strictEqual(login.status, 302);
        const loc = new URL(login.headers.get('location'));
        assert.strictEqual(loc.origin + loc.pathname, 'https://openvibe.network/oauth/authorize');
        assert.strictEqual(loc.searchParams.get('client_id'), 'billing');
        assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://billing.test/auth/callback');
        assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
        assert.match(loc.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
        assert.ok(loc.searchParams.get('state').length >= 32);
        const flow = login.cookies.find((c) => c.startsWith('ovb_flow='));
        assert.ok(flow, 'flow cookie');
        for (const attr of ['HttpOnly', 'Secure', 'Path=/auth', 'SameSite=Lax']) assert.ok(flow.includes(attr), `flow cookie ${attr}: ${flow}`);
        assert.ok(!/domain=/i.test(flow));
        assert.ok(!flow.includes(loc.searchParams.get('code_challenge')), 'the cookie carries the verifier, never the challenge');
    });

    await check('the callback refuses a missing or mismatched state and a forged flow cookie', async () => {
        const login = await get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flow = login.cookies.find((c) => c.startsWith('ovb_flow=')).split(';')[0];
        const code = network.authorize({ subject_id: staff, role: 'admin', challenge: loc.searchParams.get('code_challenge'), redirect_uri: loc.searchParams.get('redirect_uri') });
        assert.strictEqual((await get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`)).status, 400, 'no flow cookie');
        assert.strictEqual((await get(`/auth/callback?code=${code}&state=wrong`, flow)).status, 400, 'wrong state');
        const [body] = flow.slice('ovb_flow='.length).split('.');
        assert.strictEqual((await get(`/auth/callback?code=${code}&state=${loc.searchParams.get('state')}`, `ovb_flow=${body}.forged`)).status, 400, 'forged signature');
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM staff_sessions').get().n, 0);
    });

    await check('a code bound to another PKCE challenge is refused by the Network, no session', async () => {
        const login = await get('/auth/login');
        const loc = new URL(login.headers.get('location'));
        const flow = login.cookies.find((c) => c.startsWith('ovb_flow=')).split(';')[0];
        const code = network.authorize({ subject_id: staff, role: 'admin', challenge: 'A'.repeat(43), redirect_uri: loc.searchParams.get('redirect_uri') });
        const cb = await get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state'))}`, flow);
        assert.strictEqual(cb.status, 400);
        assert.ok(!cb.cookies.some((c) => c.startsWith('__Host-ovb_staff=') && !c.startsWith('__Host-ovb_staff=;')));
    });

    await check('non-staff get 403 and no session: a Network admin not listed, a listed non-admin', async () => {
        const a = await signIn(unlistedAdmin, { role: 'admin' });
        assert.strictEqual(a.cb.status, 403);
        assert.strictEqual(a.cookie, null);
        const b = await signIn(listedNonAdmin, { role: 'user' });
        assert.strictEqual(b.cb.status, 403);
        assert.strictEqual(b.cookie, null);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM staff_sessions').get().n, 0);
        const refused = auditRows('session.sign_in', 'refused');
        assert.deepStrictEqual(refused.map((r) => r.actor_subject).sort(), [listedNonAdmin, unlistedAdmin].sort());
        assert.strictEqual(staffEvents('session.sign_in').length, 0, 'refusals are not published');
    });

    await check('staff sign in: host-only, HttpOnly, Secure, SameSite=Strict, short-lived session cookie', async () => {
        const r = await signIn(staff, { username: 'goosely' });
        assert.strictEqual(r.cb.status, 303);
        assert.strictEqual(r.cb.headers.get('location'), '/cashouts');
        assert.ok(r.setCookie, 'session cookie set');
        for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(r.setCookie.includes(attr), `${attr}: ${r.setCookie}`);
        assert.ok(!/domain=/i.test(r.setCookie), 'host-only');
        const maxAge = Number((r.setCookie.match(/Max-Age=(\d+)/) || [])[1]);
        assert.ok(maxAge > 0 && maxAge <= 3600, `max-age ${maxAge}`);
        s = r.cookie;
        const row = t.db.prepare('SELECT * FROM staff_sessions').get();
        assert.notStrictEqual(row.id_hash, s.split('=')[1], 'only a hash of the session id is stored');
        assert.strictEqual(auditRows('session.sign_in').length, 1);
        assert.strictEqual(staffEvents('session.sign_in').length, 1);
    });

    await check('pages: staff only, server-rendered, no script, noindex, no-store, strict CSP', async () => {
        for (const p of ['/', '/cashouts', '/cashouts?tab=paid', '/receipts', '/import-holds', '/reconciliation', '/freeze', '/audit']) {
            const r = await get(p, s);
            assert.strictEqual(r.status, 200, `${p}: ${r.status}`);
            assert.ok(!/<script/i.test(r.text), `${p} has no script`);
            assert.ok(r.text.includes('<meta name="robots" content="noindex,nofollow">'), p);
            assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow');
            assert.strictEqual(r.headers.get('cache-control'), 'no-store');
            assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
            assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
        }
        const anon = await get('/cashouts');
        assert.strictEqual(anon.status, 401);
        assert.ok(anon.text.includes('/auth/login?next=%2Fcashouts'));
        assert.strictEqual((await get('/', null)).status, 200, 'the root shows the sign-in page');
        assert.strictEqual((await get('/robots.txt')).text, 'User-agent: *\nDisallow: /\n');
    });

    await check('the staff session is not an API credential: /api/v1 still needs a service token', async () => {
        const r = await get('/api/v1/cashouts', s);
        assert.strictEqual(r.status, 401);
    });

    let co1;
    await check('CSRF: a POST without the token, with a wrong one, or from another site changes nothing', async () => {
        co1 = await newCashout(600);
        const page = await get(`/cashouts/${co1}`, s);
        const csrf = csrfOf(page);
        const key = keyOf(page, `/cashouts/${co1}/approve`);
        assert.ok(csrf && key);
        const form = { payout_reference: 'PP-1', payout_provider: 'paypal', confirm: 'yes', action_key: key };
        assert.strictEqual((await post(`/cashouts/${co1}/approve`, s, form)).status, 403);
        assert.strictEqual((await post(`/cashouts/${co1}/approve`, s, { ...form, _csrf: 'x'.repeat(43) })).status, 403);
        assert.strictEqual((await post(`/cashouts/${co1}/approve`, s, { ...form, _csrf: csrf }, { Origin: 'https://evil.example' })).status, 403);
        assert.strictEqual((await post(`/cashouts/${co1}/approve`, s, { ...form, _csrf: csrf }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
        assert.strictEqual((await post('/freeze', s, { on: '1', reason: 'csrf test' })).status, 403);
        assert.strictEqual((await post('/auth/logout', s, {})).status, 403);
        assert.strictEqual(t.db.prepare('SELECT status FROM cashouts WHERE id = ?').get(co1).status, 'requested');
        assert.strictEqual(t.db.prepare('SELECT freeze FROM settings').get().freeze, 0);
        assert.ok(auditRows('request.csrf', 'refused').length >= 5);
        assert.strictEqual((await get('/cashouts', s)).status, 200, 'the session survived');
    });

    await check('approve is refused without a payout reference, without the confirmation, and before the escrow ends', async () => {
        const page = await get(`/cashouts/${co1}`, s);
        const csrf = csrfOf(page);
        const key = keyOf(page, `/cashouts/${co1}/approve`);
        assert.ok(page.text.includes('in escrow'), 'shown as in escrow');
        const noRef = await post(`/cashouts/${co1}/approve`, s, { _csrf: csrf, action_key: key, payout_reference: '  ', payout_provider: 'paypal', confirm: 'yes' });
        assert.strictEqual(noRef.status, 422);
        assert.ok(noRef.text.includes('billing.payout_reference_required'));
        const noConfirm = await post(`/cashouts/${co1}/approve`, s, { _csrf: csrf, action_key: key, payout_reference: 'PP-1', payout_provider: 'paypal' });
        assert.strictEqual(noConfirm.status, 422);
        const early = await post(`/cashouts/${co1}/approve`, s, { _csrf: csrf, action_key: key, payout_reference: 'PP-1', payout_provider: 'paypal', confirm: 'yes' });
        assert.strictEqual(early.status, 409);
        assert.ok(early.text.includes('billing.escrow_active'));
        assert.strictEqual(t.db.prepare('SELECT status FROM cashouts WHERE id = ?').get(co1).status, 'requested');
        assert.strictEqual(auditRows('cashout.approve').length, 0);
        assert.strictEqual(auditRows('cashout.approve', 'refused').length, 3);
        assert.strictEqual(staffEvents('cashout.approve').length, 0);
    });

    let co2;
    await check('after the escrow: approve records the payout once (a resubmitted form replays), audited once', async () => {
        co2 = await newCashout(700);
        t.clock.offset = 15 * DAY;
        assert.strictEqual((await get('/cashouts', s)).status, 401, 'the 60-minute session expired meanwhile');
        s = (await signIn(staff, { username: 'goosely' })).cookie;
        const ready = await get('/cashouts?tab=ready', s);
        assert.ok(ready.text.includes(co1) && ready.text.includes(co2));
        const page = await get(`/cashouts/${co1}`, s);
        const form = { _csrf: csrfOf(page), action_key: keyOf(page, `/cashouts/${co1}/approve`), payout_reference: 'PAYOUT-7Q2', payout_provider: 'paypal', confirm: 'yes' };
        const r = await post(`/cashouts/${co1}/approve`, s, form);
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(r.headers.get('location'), `/cashouts/${co1}?done=approved`);
        const again = await post(`/cashouts/${co1}/approve`, s, form);
        assert.strictEqual(again.status, 303);
        assert.strictEqual(again.headers.get('location'), `/cashouts/${co1}?done=already_paid`);
        const c = t.db.prepare('SELECT * FROM cashouts WHERE id = ?').get(co1);
        assert.strictEqual(c.status, 'paid');
        assert.strictEqual(c.payout_reference, 'PAYOUT-7Q2');
        assert.strictEqual(JSON.parse(c.decided_by).principal, staff);
        const rows = auditRows('cashout.approve');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].actor_subject, staff);
        assert.strictEqual(rows[0].target_id, co1);
        assert.ok(rows[0].request_id && rows[0].ip_hash && !rows[0].ip_hash.includes('127.0.0.1'));
        assert.strictEqual(JSON.parse(rows[0].detail).payout_reference, 'PAYOUT-7Q2');
        const ev = staffEvents('cashout.approve');
        assert.strictEqual(ev.length, 1);
        assert.deepStrictEqual(ev[0].actor, { type: 'user', id: staff });
        assert.strictEqual(ev[0].visibility, 'internal');
        assert.deepStrictEqual(ev[0].payload.target, { type: 'cashout', id: co1 });
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE json_extract(event, '$.event_type') = 'billing.cashout.paid'").get().n, 1);
        const shown = await get(`/cashouts/${co1}?done=approved`, s);
        assert.ok(shown.text.includes('Payout recorded') && shown.text.includes('PAYOUT-7Q2'));
        t.assertReconciled('after a console approval');
    });

    await check('deny needs a reason; it returns the amount to payable and is audited once', async () => {
        const before = (await t.balances(creator.id)).payable;
        const page = await get(`/cashouts/${co2}`, s);
        const csrf = csrfOf(page);
        const key = keyOf(page, `/cashouts/${co2}/deny`);
        const noReason = await post(`/cashouts/${co2}/deny`, s, { _csrf: csrf, action_key: key, reason: '' });
        assert.strictEqual(noReason.status, 422);
        const r = await post(`/cashouts/${co2}/deny`, s, { _csrf: csrf, action_key: key, reason: 'payout address bounced' });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual((await post(`/cashouts/${co2}/deny`, s, { _csrf: csrf, action_key: key, reason: 'payout address bounced' })).headers.get('location'), `/cashouts/${co2}?done=already_denied`);
        assert.strictEqual(t.db.prepare('SELECT status FROM cashouts WHERE id = ?').get(co2).status, 'denied');
        assert.strictEqual((await t.balances(creator.id)).payable, before + 700);
        const rows = auditRows('cashout.deny');
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].reason, 'payout address bounced');
        assert.strictEqual(staffEvents('cashout.deny').length, 1);
        const approveDenied = await post(`/cashouts/${co2}/approve`, s, { _csrf: csrf, action_key: keyOf(page, `/cashouts/${co2}/approve`), payout_reference: 'X-1', payout_provider: 'paypal', confirm: 'yes' });
        assert.strictEqual(approveDenied.status, 409, 'a denied cashout cannot be paid');
        t.assertReconciled('after a console denial');
    });

    await check('freeze toggles with a reason, refuses money actions while on, and is audited', async () => {
        const page = await get('/freeze', s);
        const csrf = csrfOf(page);
        assert.strictEqual((await post('/freeze', s, { _csrf: csrf, on: '1', reason: '' })).status, 422);
        const on = await post('/freeze', s, { _csrf: csrf, on: '1', reason: 'cutover rehearsal' });
        assert.strictEqual(on.status, 303);
        assert.strictEqual(t.db.prepare('SELECT freeze FROM settings').get().freeze, 1);
        assert.strictEqual((await post('/freeze', s, { _csrf: csrf, on: '1', reason: 'again' })).status, 409, 'no double toggle');
        const co3 = await newCashout(500).catch(() => null);
        assert.strictEqual(co3, null, 'the API refuses writes while frozen');
        const api = await t.call('POST', '/api/v1/transfers', { body: { from: fan, to: creator, amount: 5 } });
        assert.strictEqual(api.status, 503);
        // A held delivery while frozen: stored, processed on unfreeze.
        const held = await t.powerchat({ type: 'donation.completed', streamer: { username: 'openvibe' }, data: { eventId: 'console-held-1', amountUsdCents: 300 } });
        assert.strictEqual(held.status, 202);
        const dash = await get('/', s);
        assert.ok(dash.text.includes('The economy is frozen'));
        const off = await post('/freeze', s, { _csrf: csrf, on: '0', reason: 'rehearsal done' });
        assert.strictEqual(off.status, 303);
        assert.match(off.headers.get('location'), /done=unfrozen&processed=1/);
        assert.strictEqual(t.db.prepare('SELECT freeze FROM settings').get().freeze, 0);
        assert.strictEqual(auditRows('economy.freeze').length, 1);
        assert.strictEqual(auditRows('economy.freeze')[0].reason, 'cutover rehearsal');
        assert.strictEqual(auditRows('economy.unfreeze').length, 1);
        assert.strictEqual(auditRows('economy.freeze', 'refused').length, 2);
        assert.strictEqual(staffEvents('economy.freeze').length, 1);
        assert.strictEqual(staffEvents('economy.unfreeze').length, 1);
        assert.strictEqual(JSON.parse(t.db.prepare('SELECT frozen_by FROM settings').get().frozen_by || 'null'), null);
    });

    await check('a money action is refused while frozen (same guard as the API)', async () => {
        const co4 = await newCashout(500);
        const csrf = csrfOf(await get('/freeze', s));
        await post('/freeze', s, { _csrf: csrf, on: '1', reason: 'guard test' });
        const page = await get(`/cashouts/${co4}`, s);
        const r = await post(`/cashouts/${co4}/deny`, s, { _csrf: csrf, action_key: keyOf(page, `/cashouts/${co4}/deny`), reason: 'while frozen' });
        assert.strictEqual(r.status, 503);
        assert.ok(r.text.includes('billing.frozen'));
        assert.strictEqual(t.db.prepare('SELECT status FROM cashouts WHERE id = ?').get(co4).status, 'requested');
        await post('/freeze', s, { _csrf: csrf, on: '0', reason: 'guard test done' });
    });

    await check('reconciliation runs from the console, is stored, listed and audited', async () => {
        const csrf = csrfOf(await get('/reconciliation', s));
        const r = await post('/reconciliation', s, { _csrf: csrf });
        assert.strictEqual(r.status, 303);
        const id = r.headers.get('location').split('/').pop();
        assert.match(id, /^rec_/);
        const run = await get(`/reconciliation/${id}`, s);
        assert.strictEqual(run.status, 200);
        assert.ok(run.text.includes('journal.zero_sum'));
        assert.ok((await get('/reconciliation', s)).text.includes(id));
        assert.ok((await get('/', s)).text.includes(`/reconciliation/${id}`), 'the dashboard shows the last run');
        assert.strictEqual(auditRows('reconciliation.run').length, 1);
        assert.strictEqual(auditRows('reconciliation.run')[0].target_id, id);
    });

    await check('receipts needing review are listed without payloads; the console shows no secrets', async () => {
        const marker = 'PAYLOAD-MARKER-9f3a';
        const flagged = await t.powerchat({ type: 'donation.completed', streamer: { username: 'openvibe' }, data: { eventId: 'console-unattributed', amountUsdCents: 500, donorName: 'Donor Name', message: marker, donorEmail: 'payer-private@example.com' } });
        assert.strictEqual(flagged.status, 200, JSON.stringify(flagged.json));
        const rejected = await t.powerchat({ type: 'donation.refunded', streamer: { username: 'openvibe' }, data: { eventId: 'console-refund-x', originalEventId: 'nope', note: marker } });
        assert.strictEqual(rejected.json.result.effect, 'rejected');
        const page = await get('/receipts', s);
        assert.ok(page.text.includes(`<td>${flagged.json.event}</td>`) && page.text.includes('unattributed tip to the site PowerChat account'), 'the flagged site tip is listed');
        assert.ok(page.text.includes(`<td>${rejected.json.event}</td>`) && page.text.includes('rejected'), 'the rejected refund is listed');
        // Reprocess the rejected one: audited (still rejected — the cause is not fixed).
        const csrf = csrfOf(page);
        const re = await post(`/receipts/${rejected.json.event}/reprocess`, s, { _csrf: csrf });
        assert.strictEqual(re.status, 303, re.text);
        assert.strictEqual(auditRows('provider_event.reprocess').length, 1);
        assert.strictEqual((await post('/receipts/99999/reprocess', s, { _csrf: csrf })).status, 404);
        assert.strictEqual(auditRows('provider_event.reprocess', 'refused').length, 1);

        const secrets = [marker, 'payer-private@example.com', 'Donor Name', 'pc-secret', SESSION_SECRET, s.split('=')[1], '"payload"'];
        for (const p of ['/', '/receipts', '/cashouts', `/cashouts/${co1}`, '/reconciliation', '/freeze', '/audit', '/import-holds']) {
            const body = (await get(p, s)).text;
            for (const x of secrets) assert.ok(!body.includes(x), `${p} shows ${x}`);
        }
        const runId = t.db.prepare('SELECT id FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 1').get().id;
        const csrf2 = csrfOf(await get('/reconciliation', s));
        const rid = (await post('/reconciliation', s, { _csrf: csrf2 })).headers.get('location');
        const rep = (await get(rid, s)).text;
        assert.ok(runId && !rep.includes(marker) && !rep.includes('payer-private@example.com'));
    });

    await check('the audit log is append-only and shown to staff', async () => {
        assert.throws(() => t.db.prepare("UPDATE staff_audit SET reason = 'x'").run(), /append-only/);
        assert.throws(() => t.db.prepare('DELETE FROM staff_audit').run(), /append-only/);
        const page = await get('/audit', s);
        assert.ok(page.text.includes('cashout.approve') && page.text.includes('economy.freeze'));
    });

    await check('removed from BILLING_STAFF_SUBJECTS → the next request is refused and the session ends', async () => {
        const list = t.config.console.staffSubjects;
        const saved = [...list];
        list.splice(0, list.length);
        const r = await get('/cashouts', s);
        assert.strictEqual(r.status, 403);
        list.push(...saved);
        assert.strictEqual((await get('/cashouts', s)).status, 401, 'the session stays revoked');
        s = (await signIn(staff)).cookie;
    });

    await check('sign out needs CSRF, ends the session and is audited', async () => {
        const csrf = csrfOf(await get('/', s));
        const r = await post('/auth/logout', s, { _csrf: csrf });
        assert.strictEqual(r.status, 303);
        assert.ok(r.cookies.some((c) => c.startsWith('__Host-ovb_staff=;') && c.includes('Max-Age=0')));
        assert.strictEqual((await get('/cashouts', s)).status, 401);
        assert.strictEqual(auditRows('session.sign_out').length, 1);
        assert.ok(network.revoked.length >= 3, 'every Network refresh token handed to Billing was revoked, never kept');
    });

    await t.close();
    await network.close();
    done();
})();
