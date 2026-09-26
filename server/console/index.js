'use strict';

/**
 * The Billing staff console — server-rendered, no JavaScript, at the root of
 * billing.openvibe.network. It replaces Live's cashout admin once Live runs with
 * BILLING_AUTHORITY=billing (docs/live-cutover.md).
 *
 *   GET  /auth/login, /auth/callback     Network SSO (authorization code + PKCE S256, client `billing`)
 *   POST /auth/logout
 *   GET  /                               dashboard: freeze state, last reconciliation, outstanding totals
 *   GET  /cashouts?tab=escrow|ready|paid|denied, /cashouts/:id
 *   POST /cashouts/:id/approve           payout_reference + payout_provider + confirm (ops/cashouts.approve)
 *   POST /cashouts/:id/deny              reason (ops/cashouts.deny)
 *   GET  /receipts                       provider receipts needing review; POST /receipts/:id/reprocess
 *   GET  /import-holds
 *   GET  /reconciliation, /reconciliation/:id; POST /reconciliation (reconcile.js)
 *   GET  /freeze; POST /freeze           on/off + reason (ops/admin.setFreeze, then the held webhooks)
 *   GET  /audit                          the staff_audit log
 *
 * Who: a Network user whose token says role `admin` AND whose subject is listed in
 * BILLING_STAFF_SUBJECTS — checked at sign-in, and the list again on every request. Everyone else
 * is refused (403) and no session is created.
 *
 * What a staff session may do is decided by the same capability ids the API checks: a staff
 * session is the principal { sub: <usr_…>, cap: [billing.cashout.manage, billing.ledger.admin] }
 * and each route names the one capability it needs. Every change goes through the same functions
 * the API calls (server/ops/*, reconcile.js, providers.reprocess/processPending) with the same
 * freeze guard; nothing here moves money on its own. Each staff action writes one staff_audit row
 * and one billing.staff.action outbox event, in the same SQLite transaction as its effect.
 */
const crypto = require('crypto');
const express = require('express');
const { capabilities, staff: staffMap } = require('openvibe-contracts');
const { BillingError, balance } = require('../ledger');
const { A, assertNotFrozen, isFrozen, text } = require('../ops/common');
const cashouts = require('../ops/cashouts');
const admin = require('../ops/admin');
const providers = require('../providers');
const { reconcile } = require('../reconcile');
const { CAP } = require('../api/v1');
const { createSessions, sameString, random } = require('./session');
const sso = require('./sso');
const audit = require('./audit');
const q = require('./queries');
const { CSP, pages, setShipped } = require('./views');

/** Server-side mapping: what a staff session holds, in the API's own capability ids. */
const STAFF_CAPABILITIES = Object.freeze([CAP.cashoutManage, CAP.admin]);
const PAYOUT_PROVIDERS = ['paypal', 'wise', 'bank', 'crypto', 'other'];
const ACTION_KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

const NOTICES = {
    approved: 'Payout recorded: the cashout is paid.',
    already_paid: 'This cashout was already paid with that reference — nothing changed.',
    denied: 'Cashout denied: the amount is back in the creator\'s payable.',
    already_denied: 'This cashout was already denied — nothing changed.',
    frozen: 'The economy is frozen.',
    unfrozen: 'The economy is open again.',
    reprocessed: 'The receipt was reprocessed.',
    reconciled: 'Reconciliation finished.',
};

function sanitizeNext(v) {
    // Browsers drop tab and newline characters from a URL and read a backslash as "/": "/<TAB>/evil.com" would
    // leave the site. A next with any control character or backslash goes home.
    if (typeof v === 'string' && /[\u0000-\u001f\u007f\\]/.test(v)) return '/';
    const s = String(v || '');
    if (s.length > 300 || !/^\/(?![/\\])/.test(s) || s.startsWith('/auth/')) return '/';
    return s;
}

function consoleRouter({ ctx, adapters, keys, fetchImpl = globalThis.fetch }) {
    const { db, config } = ctx;
    const cc = config.console;
    const log = ctx.log || console;
    const r = express.Router();
    const baseOrigin = (() => { try { return new URL(config.baseUrl).origin; } catch { return null; } })();

    // The footer's "shipped" line: read the network changelog (Network's loopback proxy) at most once a
    // minute, in the background of a request; the page never waits for it and a failure shows nothing.
    let shippedReadAt = 0;
    r.use((req, res, next) => {
        const now = Date.now();
        if (now - shippedReadAt > 60 * 1000 && config.network && config.network.internalUrl) {
            shippedReadAt = now;
            Promise.resolve(fetchImpl(`${config.network.internalUrl}/api/v1/changelog?service=billing&limit=1`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2000) }))
                .then((x) => (x && x.ok ? x.json() : null))
                .then((d) => { if (d && Array.isArray(d.entries) && d.entries[0]) setShipped(d.entries[0]); })
                .catch(() => { /* the line just stays as it was */ });
        }
        next();
    });

    let secret = cc.sessionSecret;
    let unavailable = null;
    if (!secret || secret.length < 32) {
        if (config.isProduction) unavailable = 'BILLING_SESSION_SECRET (at least 32 characters) is not set';
        else { secret = crypto.randomBytes(32).toString('hex'); if (config.nodeEnv !== 'test') log.warn('[Billing] console: BILLING_SESSION_SECRET unset — using an ephemeral secret (development only)'); }
    }
    if (!config.oauth.clientSecret) unavailable = unavailable || 'OV_OAUTH_CLIENT_SECRET is not set';
    if (cc.invalidStaffSubjects.length) log.warn(`[Billing] console: ignoring ${cc.invalidStaffSubjects.length} malformed BILLING_STAFF_SUBJECTS entr${cc.invalidStaffSubjects.length === 1 ? 'y' : 'ies'} (usr_ + ULID expected)`);
    if (!cc.staffSubjects.length && config.nodeEnv !== 'test') log.warn('[Billing] console: BILLING_STAFF_SUBJECTS is empty — nobody can sign in');
    if (unavailable) log.warn(`[Billing] console disabled: ${unavailable}`);
    const sessions = createSessions(ctx, { secret: secret || 'unavailable' });

    const send = (res, status, htmlText) => res.status(status).type('html').send(htmlText);
    const ipHash = (req) => sessions.ipHash(req.ip);
    const requestId = (req) => (req.ov ? req.ov.requestId : null);
    const trace = (req) => (req.ov ? req.ov.traceId : undefined);
    const actorOf = (req) => ({ principal: req.staff.subject, via: 'staff-console', username: req.staff.username || undefined, request_id: requestId(req) });
    const record = (req, fields) => audit.record(ctx, {
        actor: req.staff ? { subject: req.staff.subject, username: req.staff.username } : fields.actor,
        requestId: requestId(req), ipHash: ipHash(req), traceId: trace(req), ...fields,
    });
    const common = (req) => ({ staff: req.staff, csrf: req.staff ? req.staff.csrf : '', frozen: isFrozen(db) });

    // ── Every console response ───────────────────────────────
    r.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        if (unavailable) return send(res, 503, pages.message({ title: 'Console unavailable', text: 'The staff console is not configured on this host. The operator must set its environment (see .env.example).' }));
        return next();
    });
    r.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 }));

    // ── Session → req.staff ──────────────────────────────────
    r.use((req, res, next) => {
        req.staff = null;
        const row = sessions.read(req);
        if (!row) return next();
        if (!cc.staffSubjects.includes(row.subject) || !staffMap.can(row.role || 'user', cc.staffCapability)) {
            sessions.revoke(row);
            sessions.clear(res);
            audit.record(ctx, { actor: { subject: row.subject, username: row.username }, action: 'session.use', outcome: 'refused', reason: cc.staffSubjects.includes(row.subject) ? `the session's role does not hold ${cc.staffCapability}` : 'no longer listed in BILLING_STAFF_SUBJECTS', requestId: requestId(req), ipHash: ipHash(req) });
            return send(res, 403, pages.message({ title: 'Not authorized', text: 'Your account is no longer Billing staff. The session was ended.' }));
        }
        req.staff = { subject: row.subject, username: row.username, role: row.role, csrf: row.csrf, session: row, principal: { sub: row.subject, cap: STAFF_CAPABILITIES } };
        return next();
    });

    /** Staff only, holding `cap` through the staff mapping. POSTs also need the CSRF token. */
    function needs(cap) {
        return (req, res, next) => {
            if (!req.staff) {
                if (req.method === 'GET') return send(res, 401, pages.signIn({ next: sanitizeNext(req.originalUrl) }));
                return send(res, 401, pages.signIn({ message: 'Your session has ended. Sign in again, then repeat the action.' }));
            }
            if (!capabilities.grants(req.staff.principal.cap, cap)) {
                return send(res, 403, pages.message({ title: 'Not authorized', text: `This needs ${cap}.`, ...common(req) }));
            }
            if (req.method === 'POST' && !csrfOk(req)) {
                record(req, { action: 'request.csrf', outcome: 'refused', reason: 'missing or invalid CSRF token / cross-site request', detail: { path: req.path } });
                return send(res, 403, pages.message({ title: 'Request refused', text: 'The form was stale or came from another site. Reload the page and try again.', ...common(req) }));
            }
            return next();
        };
    }
    function csrfOk(req) {
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return false;
        const origin = req.headers.origin;
        if (origin && origin !== baseOrigin) return false;
        return sameString((req.body || {})._csrf, req.staff.csrf);
    }
    const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch((e) => {
        log.error('[Billing] console error:', e);
        if (!res.headersSent) send(res, 500, pages.message({ title: 'Error', text: 'Something went wrong. Nothing was changed unless the page says so; check the audit log.', ...common(req) }));
    });
    const actionKey = (v) => (ACTION_KEY_RE.test(String(v || '')) ? String(v) : null);
    const doneNotice = (req) => NOTICES[req.query.done] ? `${NOTICES[req.query.done]}${req.query.processed ? ` ${Number(req.query.processed) || 0} held webhook(s) processed.` : ''}` : null;

    // ── Sign-in ──────────────────────────────────────────────
    r.get('/auth/login', (req, res) => {
        const state = random(32);
        const { verifier, challenge } = sso.pkcePair();
        sessions.setFlow(res, { s: state, v: verifier, n: sanitizeNext(req.query.next) });
        res.redirect(302, sso.authorizeUrl(config, { state, challenge }));
    });

    r.get('/auth/callback', wrap(async (req, res) => {
        const flow = sessions.takeFlow(req, res);
        if (req.query.error) return send(res, 400, pages.signIn({ message: `Sign-in was not completed (${String(req.query.error).slice(0, 60)}).` }));
        if (!flow || !req.query.code || !sameString(req.query.state, flow.s)) {
            return send(res, 400, pages.signIn({ message: 'The sign-in could not be verified (expired or mismatched state). Please try again.' }));
        }
        let who;
        try {
            const publicKey = keys.get() || await keys.load();
            if (!publicKey) throw new Error('the Network key is not loaded');
            who = await sso.exchange(ctx, { code: req.query.code, verifier: flow.v, publicKey, fetchImpl });
        } catch (e) {
            log.warn(`[Billing] console sign-in failed: ${e.message}`);
            return send(res, e.status && e.status < 500 ? 400 : 502, pages.signIn({ message: 'OpenVibe.Network did not confirm the sign-in. Please try again.' }));
        }
        const listed = !!who.subject && cc.staffSubjects.includes(who.subject);
        if (!listed || !who.money) {
            audit.record(ctx, {
                actor: { subject: who.subject, username: who.username }, action: 'session.sign_in', outcome: 'refused',
                reason: !who.subject ? 'token carries no subject' : !who.money ? `the token does not hold ${cc.staffCapability} (role ${who.role || 'none'})` : 'not listed in BILLING_STAFF_SUBJECTS',
                requestId: requestId(req), ipHash: ipHash(req),
            });
            return send(res, 403, pages.message({ title: 'Not authorized', text: 'This console is only for OpenVibe.Network admins who are Billing staff. Your sign-in was recorded.' }));
        }
        db.transaction(() => {
            sessions.create(res, { subject: who.subject, username: who.username, role: who.role, ip: req.ip });
            audit.record(ctx, { actor: { subject: who.subject, username: who.username }, action: 'session.sign_in', requestId: requestId(req), ipHash: ipHash(req), traceId: trace(req) });
        })();
        return res.redirect(303, flow.n || '/');
    }));

    r.post('/auth/logout', needs(CAP.cashoutManage), (req, res) => {
        db.transaction(() => {
            sessions.revoke(req.staff.session);
            record(req, { action: 'session.sign_out' });
        })();
        sessions.clear(res);
        res.redirect(303, '/');
    });

    // ── Dashboard ────────────────────────────────────────────
    r.get('/', (req, res) => {
        if (!req.staff) return send(res, 200, pages.signIn({}));
        return send(res, 200, pages.dashboard({
            ...common(req), freeze: admin.freezeState(db), last: q.lastReconciliation(db), totals: q.outstanding(db),
            counts: q.counts(db, ctx.now()), rates: ctx.rates,
        }));
    });

    // ── Cashouts ─────────────────────────────────────────────
    r.get('/cashouts', needs(CAP.cashoutManage), (req, res) => {
        const tab = q.CASHOUT_TABS[req.query.tab] ? req.query.tab : 'ready';
        send(res, 200, pages.cashouts({ ...common(req), tab, tabs: q.CASHOUT_TABS, rows: q.cashoutQueue(db, tab, ctx.now()), counts: q.counts(db, ctx.now()), nowMs: ctx.now(), rates: ctx.rates }));
    });

    function cashoutPage(req, res, status, c, extra = {}) {
        return send(res, status, pages.cashout({
            ...common(req), c, nowMs: ctx.now(), approveKey: random(18), denyKey: random(18),
            balances: { payable: balance(db, A.payable(c.subject)), pending: balance(db, A.pending(c.subject)) },
            history: db.prepare("SELECT * FROM staff_audit WHERE target_type = 'cashout' AND target_id = ? ORDER BY seq DESC LIMIT 50").all(c.id).map((x) => ({ ...x, detail: JSON.parse(x.detail) })),
            notice: doneNotice(req), ...extra,
        }));
    }
    r.get('/cashouts/:id', needs(CAP.cashoutManage), (req, res) => {
        const c = cashouts.find(db, req.params.id);
        if (!c) return send(res, 404, pages.message({ title: 'Not found', text: `No cashout ${req.params.id}.`, ...common(req) }));
        return cashoutPage(req, res, 200, c);
    });

    /** Run a cashout decision through ops; audit once (not on a replay); refusals audited as refused. */
    function decide(action, run, validate) {
        return (req, res) => {
            const c = cashouts.find(db, req.params.id);
            if (!c) return send(res, 404, pages.message({ title: 'Not found', text: `No cashout ${req.params.id}.`, ...common(req) }));
            const b = req.body || {};
            const target = { type: 'cashout', id: c.id };
            const form = { payout_reference: String(b.payout_reference || '').trim().slice(0, 200), payout_provider: String(b.payout_provider || '').slice(0, 20), reason: String(b.reason || '').slice(0, 300) };
            try {
                const key = actionKey(b.action_key);
                if (!key) throw new BillingError(422, 'console.stale_form', 'the form is missing its action key; reload the page');
                if (validate) validate(b);
                const out = db.transaction(() => {
                    assertNotFrozen(ctx);          // the API's notFrozen guard
                    const o = run(req, c, b, `staff:${action}:${key}`);
                    if (!o.replay) {
                        record(req, {
                            action, target, reason: action === 'cashout.deny' ? form.reason : null,
                            detail: action === 'cashout.approve'
                                ? { payout_reference: o.cashout.payout_reference, payout_provider: o.cashout.payout_provider, amount_bits: c.amount_bits, value_cents: c.value_cents, txn: o.cashout.settle_txn }
                                : { amount_bits: c.amount_bits, txn: o.cashout.settle_txn },
                        });
                    }
                    return o;
                })();
                const done = action === 'cashout.approve' ? (out.replay ? 'already_paid' : 'approved') : (out.replay ? 'already_denied' : 'denied');
                return res.redirect(303, `/cashouts/${encodeURIComponent(c.id)}?done=${done}`);
            } catch (e) {
                if (!(e instanceof BillingError)) throw e;
                record(req, { action, target, outcome: 'refused', reason: action === 'cashout.deny' ? form.reason || null : null, detail: { code: e.code } });
                return cashoutPage(req, res, e.status, cashouts.find(db, c.id), { error: `${e.detail || e.message} (${e.code})`, form });
            }
        };
    }

    r.post('/cashouts/:id/approve', needs(CAP.cashoutManage), wrap(decide('cashout.approve', (req, c, b, key) => {
        const provider = String(b.payout_provider || 'paypal').toLowerCase();
        return cashouts.approve(ctx, { id: c.id, payout_reference: b.payout_reference, payout_provider: provider, idempotencyKey: key, actor: actorOf(req) });
    }, (b) => {
        if (!text(b.payout_reference, 'payout_reference', 200)) throw new BillingError(422, 'billing.payout_reference_required', 'approving a payout needs the payout reference from the provider');
        if (!PAYOUT_PROVIDERS.includes(String(b.payout_provider || 'paypal').toLowerCase())) throw new BillingError(422, 'billing.invalid_input', `payout provider must be one of ${PAYOUT_PROVIDERS.join(', ')}`);
        if (b.confirm !== 'yes') throw new BillingError(422, 'console.confirm_required', 'tick the confirmation that the payout was sent');
    })));

    r.post('/cashouts/:id/deny', needs(CAP.cashoutManage), wrap(decide('cashout.deny', (req, c, b, key) => (
        cashouts.deny(ctx, { id: c.id, reason: b.reason, idempotencyKey: key, actor: actorOf(req) })
    ), (b) => {
        if (!text(b.reason, 'reason', 300)) throw new BillingError(422, 'console.reason_required', 'a denial needs a reason');
    })));

    // ── Receipts needing review ──────────────────────────────
    r.get('/receipts', needs(CAP.admin), (req, res) => send(res, 200, pages.receipts({ ...common(req), q: q.reviewQueue(db), notice: doneNotice(req) })));
    r.post('/receipts/:id/reprocess', needs(CAP.admin), wrap(async (req, res) => {
        const id = Number(req.params.id);
        const target = { type: 'provider_event', id: req.params.id };
        try {
            if (!Number.isInteger(id) || id <= 0) throw new BillingError(404, 'billing.event_not_found', `no provider event ${req.params.id}`);
            assertNotFrozen(ctx);
            const row = await providers.reprocess(ctx, adapters, id);
            record(req, { action: 'provider_event.reprocess', target, detail: { processed: !!row.processed_at, effect: row.result ? row.result.effect : null, code: row.result && row.result.code ? row.result.code : undefined } });
            return res.redirect(303, '/receipts?done=reprocessed');
        } catch (e) {
            if (!(e instanceof BillingError)) throw e;
            record(req, { action: 'provider_event.reprocess', target, outcome: 'refused', detail: { code: e.code } });
            return send(res, e.status, pages.receipts({ ...common(req), q: q.reviewQueue(db), error: `${e.detail || e.message} (${e.code})` }));
        }
    }));

    r.get('/import-holds', needs(CAP.admin), (req, res) => send(res, 200, pages.holds({ ...common(req), rows: q.importHolds(db) })));

    // ── Reconciliation ───────────────────────────────────────
    r.get('/reconciliation', needs(CAP.admin), (req, res) => send(res, 200, pages.reconciliation({ ...common(req), runs: q.reconciliationRuns(db), notice: doneNotice(req) })));
    r.get('/reconciliation/:id', needs(CAP.admin), (req, res) => {
        const run = q.reconciliationRun(db, req.params.id);
        if (!run) return send(res, 404, pages.message({ title: 'Not found', text: `No reconciliation run ${req.params.id}.`, ...common(req) }));
        return send(res, 200, pages.reconciliationRun({ ...common(req), run }));
    });
    r.post('/reconciliation', needs(CAP.admin), (req, res) => {
        const report = db.transaction(() => {
            const rep = reconcile(ctx, { trigger: 'console' });
            record(req, { action: 'reconciliation.run', target: { type: 'reconciliation_run', id: rep.id }, detail: { ok: rep.ok, failed: rep.checks.filter((c) => !c.ok).map((c) => c.id) } });
            return rep;
        })();
        res.redirect(303, `/reconciliation/${encodeURIComponent(report.id)}`);
    });

    // ── Freeze ───────────────────────────────────────────────
    const heldCount = () => db.prepare('SELECT COUNT(*) AS n FROM provider_events WHERE processed_at IS NULL').get().n;
    r.get('/freeze', needs(CAP.admin), (req, res) => send(res, 200, pages.freeze({ ...common(req), state: admin.freezeState(db), held: heldCount(), notice: doneNotice(req) })));
    r.post('/freeze', needs(CAP.admin), wrap(async (req, res) => {
        const b = req.body || {};
        const on = b.on === '1';
        const action = on ? 'economy.freeze' : 'economy.unfreeze';
        const target = { type: 'settings', id: 'freeze' };
        const refuse = (status, code, detail) => {
            record(req, { action, target, outcome: 'refused', reason: b.reason ? String(b.reason).slice(0, 300) : null, detail: { code } });
            return send(res, status, pages.freeze({ ...common(req), state: admin.freezeState(db), held: heldCount(), error: detail }));
        };
        if (b.on !== '1' && b.on !== '0') return refuse(422, 'billing.invalid_input', 'on must be 1 or 0');
        let reason;
        try { reason = text(b.reason, 'reason', 300); } catch (e) { return refuse(422, e.code, e.detail); }
        if (!reason) return refuse(422, 'console.reason_required', `${on ? 'Freezing' : 'Unfreezing'} needs a reason.`);
        if (isFrozen(db) === on) return refuse(409, 'console.no_change', `The economy is already ${on ? 'frozen' : 'open'}.`);
        db.transaction(() => {
            admin.setFreeze(ctx, { on, reason, actor: actorOf(req) });
            record(req, { action, target, reason });
        })();
        // As POST /api/v1/admin/freeze: deliveries stored while frozen are processed now, in order.
        const drained = on ? null : await providers.processPending(ctx, adapters);
        return res.redirect(303, `/freeze?done=${on ? 'frozen' : 'unfrozen'}${drained ? `&processed=${drained.processed || 0}` : ''}`);
    }));

    r.get('/audit', needs(CAP.admin), (req, res) => send(res, 200, pages.audit({ ...common(req), rows: audit.list(db) })));

    return r;
}

module.exports = { consoleRouter, STAFF_CAPABILITIES, sanitizeNext };
