'use strict';

/**
 * Vibes Pay (D12 step 4): a developer app sells an item for whole Vibes.
 *
 *   POST /api/v1/vibes/charges                 app token, billing.vibes.charge; idempotent on the app's reference
 *   GET  /api/v1/vibes/charges/:id             app token; its own charge only
 *   POST /api/v1/vibes/charges/:id/refund      app token; paid -> refunded, once
 *   POST /api/v1/vibes/sandbox/grants          sandbox app token; test Vibes for the app's testing
 *   GET  /api/v1/vibes/me                      app token delegated by a person; billing.vibes-wallet@1
 *
 *   GET  /api/me/vibes/charges/:id             the pay sheet: the app, the item, the price, the person's Vibes
 *   POST /api/me/vibes/charges/:id/pay         the person pays (atomic, once, never below zero)
 *   POST /api/me/vibes/charges/:id/cancel      the person closes a pending charge
 *
 * A real payment moves whole Vibes from user_credit:<person> to project_payable:project:<prj_id> in one balanced
 * journal transaction. A sandbox payment moves test Vibes between vibes_credit_sandbox and
 * project_payable_sandbox and is marked test, so it never touches a real balance. The charge row is locked and its
 * status checked before any movement; the journal's idempotency key makes a replay move nothing.
 *
 * An app webhook is enqueued in vibes_webhook_outbox in the same transaction (src/ops/vibes-webhooks.js delivers
 * it, signed and retried). The same payload goes to OpenVibe.Events as billing.vibes.charge.paid@1/refunded@1; it
 * carries an opaque payer_ref and no person id or email.
 */
const crypto = require('crypto');
const { validate } = require('openvibe-contracts');
const { balance, post, money, accountId, iso, prefixedId, BillingError } = require('../ledger');
const { A, entry, fail, userSubject, positiveInt, text, assertNotFrozen } = require('./common');
const { enqueue } = require('../outbox');
const { enqueueWebhook } = require('./vibes-webhooks');

const CHARGE_ID_RE = /^vch_[0-9A-HJKMNP-TV-Z]{26}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DAY_MS = 86_400_000;
const MAX_VIBES = 10_000_000;

const isoOf = (v) => {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString() : String(v);
};
const num = (v) => Number(String(v == null ? 0 : v));
const isSandbox = (row) => row.sandbox === true || row.sandbox === 1 || row.sandbox === '1';

function requireApp(principal) {
    if (!principal || principal.kind !== 'app' || !principal.appId) fail(403, 'capability.denied', 'an app token is required');
    return principal;
}

function assertVibesPay(config) {
    if (!config.vibes || config.vibes.pay !== true) fail(403, 'billing.vibes_pay_disabled', 'Vibes Pay is off');
}
function assertVibesSandbox(config) {
    if (!config.vibes || config.vibes.sandbox !== true) fail(403, 'billing.vibes_sandbox_disabled', 'sandbox Vibes are off');
}
function assertAuthority(config) {
    if (config.authority !== 'billing') fail(409, 'billing.not_authoritative', 'OpenVibe.Live keeps the Vibes ledger until Billing is authoritative');
}

function chargeId(v) {
    const id = String(v == null ? '' : v);
    if (!CHARGE_ID_RE.test(id)) fail(404, 'billing.charge_not_found', 'no such payment link');
    return id;
}
function idempotencyKey(v) {
    const s = String(v == null ? '' : v).trim();
    if (!KEY_RE.test(s)) fail(422, 'billing.invalid_input', 'idempotency_key must be 8-128 characters of letters, digits, dot, colon, underscore or dash');
    return s;
}

/** A return URL is https in production (http only in development/tests), never a fragment or credentials. */
function returnUrlOf(v, config) {
    if (v == null || v === '') return null;
    let u;
    try { u = new URL(String(v)); } catch { fail(422, 'billing.invalid_input', 'return_url must be an http(s) URL'); }
    if (u.username || u.password || u.hash) fail(422, 'billing.invalid_input', 'return_url carries no credentials or fragment');
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && config.nodeEnv !== 'production')) fail(422, 'billing.invalid_input', 'return_url must be https');
    if (u.href.length > 1000) fail(422, 'billing.invalid_input', 'return_url is too long');
    return u.href;
}

/** The pay sheet's public shape (billing.vibes-charge@1): the app id as a string, whole Vibes, ISO times. */
function presentCharge(row) {
    if (!row) return null;
    return {
        id: row.id,
        app: row.app_id,
        project_id: row.project_id,
        amount: row.amount_text != null ? num(row.amount_text) : num(row.amount),
        description: row.description,
        reference: row.reference,
        status: row.status,
        pay_url: row.pay_url,
        return_url: row.return_url || null,
        created_at: isoOf(row.created_at),
        paid_at: isoOf(row.paid_at),
        refunded_at: isoOf(row.refunded_at),
        expires_at: isoOf(row.expires_at),
        sandbox: isSandbox(row),
    };
}

/** The webhook and Events body (billing.vibes.charge.paid@1 / .refunded@1): the charge plus an opaque payer_ref. */
function webhookPayload(row, status) {
    const p = {
        id: row.id,
        app: row.app_id,
        project_id: row.project_id,
        amount: row.amount_text != null ? num(row.amount_text) : num(row.amount),
        description: row.description,
        reference: row.reference,
        status,
        created_at: isoOf(row.created_at),
        paid_at: isoOf(row.paid_at),
        refunded_at: status === 'refunded' ? isoOf(row.refunded_at) : null,
        expires_at: isoOf(row.expires_at),
        sandbox: isSandbox(row),
        payer_ref: row.payer_ref,
    };
    const v = validate(`billing.vibes.charge.${status}@1`, p);
    if (!v.valid) throw new BillingError(500, 'billing.webhook_invalid', `the ${status} webhook does not match its contract: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    return p;
}

/** The account a charge's payer spends from: a person's real Vibes, or that app's test pocket. */
function payerAccount(sandbox, appId, subject) {
    return sandbox ? A.vibesSandbox(appId, subject) : A.credit(subject);
}
/** The account a paid charge lands in: the project's real Vibes wallet, or its test wallet. */
function projectAccount(sandbox, appId, projectId) {
    return sandbox ? A.projectPayableSandbox(appId, projectId) : A.projectPayable(projectId);
}

/** Create or replay a charge. (app_id, reference) is the app's idempotency key; a different body is a conflict. */
async function createCharge(ctx, principal, body) {
    const app = requireApp(principal);
    const b = body == null ? {} : body;
    const v = validate('billing.vibes-charge-create-request@1', b);
    if (!v.valid) fail(422, 'billing.invalid_request', `not a billing.vibes-charge-create-request@1: ${v.errors.slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
    const amount = positiveInt(b.amount, 'amount', MAX_VIBES);
    const sandbox = app.env === 'sandbox';
    if (sandbox) assertVibesSandbox(ctx.config);
    else {
        assertVibesPay(ctx.config);
        const max = Number(ctx.config.vibes.maxChargeVibes) || 0;
        if (max <= 0) fail(403, 'billing.vibes_limit_exceeded', 'the largest single charge is closed by the owner');
        if (amount > max) fail(403, 'billing.vibes_limit_exceeded', `the largest single charge is ${max} Vibes`, { max_charge_vibes: max, amount });
    }
    await assertNotFrozen(ctx);
    const returnUrl = returnUrlOf(b.return_url, ctx.config);
    const description = String(b.description).trim();
    const reference = String(b.reference).trim();

    return await money(ctx.db, async () => {
        const db = ctx.db;
        const now = ctx.now();
        const nowIso = iso(now);
        const find = async () => await db.prepare('SELECT *, amount::text AS amount_text FROM vibes_charges WHERE app_id = ? AND reference = ?').get(app.appId, reference);
        const replay = (row) => {
            const same = num(row.amount_text) === amount && row.description === description && (row.return_url || null) === returnUrl;
            if (!same) fail(409, 'billing.reference_reused', 'the same reference was used for a different charge');
            return { charge: presentCharge(row), replay: true };
        };
        const existing = await find();
        if (existing) return replay(existing);
        const id = prefixedId('vch', now);
        const row = await db.prepare(`INSERT INTO vibes_charges
            (id, app_id, project_id, amount, description, reference, status, pay_url, return_url, sandbox, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?::timestamptz, ?::timestamptz)
            ON CONFLICT (app_id, reference) DO NOTHING
            RETURNING *, amount::text AS amount_text`).get(
            id, app.appId, app.projectId, amount, description, reference,
            `${String(ctx.config.vibes.payBaseUrl).replace(/\/+$/, '')}/pay/${id}`, returnUrl, sandbox ? 1 : 0,
            iso(now + ctx.config.vibes.chargeTtlSeconds * 1000), nowIso);
        if (!row) {
            const raced = await find();
            if (!raced) throw new BillingError(409, 'billing.reference_reused', 'this reference is already being used');
            return replay(raced);
        }
        return { charge: presentCharge(row), replay: false };
    });
}

async function findCharge(db, id) {
    return await db.prepare('SELECT *, amount::text AS amount_text FROM vibes_charges WHERE id = ?').get(id);
}

async function getChargeForApp(ctx, principal, id) {
    const app = requireApp(principal);
    const row = await findCharge(ctx.db, chargeId(id));
    if (!row || row.app_id !== app.appId) fail(404, 'billing.charge_not_found', 'no such payment link');
    return { charge: presentCharge(row) };
}

/** Refund a paid charge whole, once, from the project's Vibes wallet back to the person who paid it. */
async function refundCharge(ctx, principal, id, body) {
    const app = requireApp(principal);
    const cid = chargeId(id);
    const v = validate('billing.vibes-charge-refund-request@1', body == null ? {} : body);
    if (!v.valid) fail(422, 'billing.invalid_request', `not a billing.vibes-charge-refund-request@1: ${v.errors.slice(0, 5).map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
    const reason = text(body && body.reason, 'reason', 300);
    await assertNotFrozen(ctx);

    return await money(ctx.db, async () => {
        const db = ctx.db;
        const row = await db.prepare('SELECT *, amount::text AS amount_text FROM vibes_charges WHERE id = ? FOR UPDATE').get(cid);
        if (!row || row.app_id !== app.appId) fail(404, 'billing.charge_not_found', 'no such payment link');
        if (row.status === 'refunded') return { charge: presentCharge(row), replay: true };
        if (row.status !== 'paid') fail(409, 'billing.charge_not_paid', `this charge is ${row.status}, not paid`);
        const sandbox = isSandbox(row);
        if (!row.payer_subject) fail(409, 'billing.charge_not_paid', 'this charge has no payer to refund');
        if (!sandbox) assertAuthority(ctx.config);
        const amount = num(row.amount_text);
        const from = projectAccount(sandbox, row.app_id, row.project_id);
        const to = payerAccount(sandbox, row.app_id, row.payer_subject);
        const have = await balance(db, from);
        if (have < amount) fail(402, 'billing.insufficient_vibes', `the project's Vibes wallet holds ${have}, not the ${amount} to refund`, { available: have, required: amount });
        const now = ctx.now();
        const nowIso = iso(now);
        const { txn } = await post(ctx, {
            type: 'vibes_refund', idempotencyKey: `vibes:refund:${row.id}`, test: sandbox,
            actor: { type: 'app', id: row.app_id }, fromSubject: null, toSubject: row.payer_subject,
            entries: [entry(from, -amount), entry(to, amount)],
            metadata: { vibes_charge: 'refund', charge_id: row.id, app_id: row.app_id, project_id: row.project_id, amount },
        });
        const updated = await db.prepare(`UPDATE vibes_charges SET status = 'refunded', refunded_at = ?::timestamptz, refund_reason = ?
            WHERE id = ? RETURNING *, amount::text AS amount_text`).get(nowIso, reason, row.id);
        const payload = webhookPayload(updated, 'refunded');
        await enqueueWebhook(ctx, updated, 'billing.vibes.charge.refunded', payload);
        await enqueue(ctx, { event_type: 'billing.vibes.charge.refunded', subject: { type: 'vibes-charge', id: row.id }, payload });
        return { charge: presentCharge(updated), replay: false, transaction_id: txn.id };
    });
}

/** The opaque payer_ref: random, stable per (app, person), never derived from the person's id. */
async function payerRef(ctx, appId, subject) {
    const db = ctx.db;
    const existing = await db.prepare('SELECT payer_ref FROM vibes_payers WHERE app_id = ? AND subject = ?').get(appId, subject);
    if (existing) return existing.payer_ref;
    const ref = `pr_${crypto.randomBytes(16).toString('hex')}`;
    await db.prepare(`INSERT INTO vibes_payers (app_id, subject, payer_ref, created_at) VALUES (?, ?, ?, ?::timestamptz)
        ON CONFLICT (app_id, subject) DO NOTHING`).run(appId, subject, ref, iso(ctx.now()));
    const row = await db.prepare('SELECT payer_ref FROM vibes_payers WHERE app_id = ? AND subject = ?').get(appId, subject);
    if (!row) throw new BillingError(500, 'billing.payer_ref', 'could not record the payer reference');
    return row.payer_ref;
}

/** How many Vibes the person has already paid in apps in the last 24 h (refunded charges do not count). */
async function spentToday(db, subject, now) {
    const row = await db.prepare(`SELECT COALESCE(SUM(amount), 0)::text AS n FROM vibes_charges
        WHERE payer_subject = ? AND status = 'paid' AND paid_at > ?::timestamptz`).get(subject, iso(now - DAY_MS));
    return num(row.n);
}

/** Pay a pending charge: locked, status-checked, once, never below zero. Returns the person's view of it. */
async function payCharge(ctx, subject, id, body) {
    const person = userSubject(subject, 'subject');
    const cid = chargeId(id);
    const key = idempotencyKey(body && body.idempotency_key);
    await assertNotFrozen(ctx);

    const out = await money(ctx.db, async () => {
        const db = ctx.db;
        const now = ctx.now();
        const row = await db.prepare('SELECT *, amount::text AS amount_text FROM vibes_charges WHERE id = ? FOR UPDATE').get(cid);
        if (!row) fail(404, 'billing.charge_not_found', 'no such payment link');
        if (row.status === 'paid' && row.payer_subject === person) {
            return { charge: presentCharge(row), vibes_credit: await balance(db, payerAccount(isSandbox(row), row.app_id, person)), replay: true };
        }
        if (row.status === 'paid') fail(409, 'billing.charge_not_pending', 'this charge was already paid by another person');
        if (row.status !== 'pending') fail(409, 'billing.charge_not_pending', `this charge is ${row.status}`);
        if (new Date(row.expires_at).getTime() <= now) {
            // Commit the expiry (it is a state change, not a refusal side effect); answer the 409 outside the transaction.
            const expired = await db.prepare(`UPDATE vibes_charges SET status = 'expired' WHERE id = ? AND status = 'pending' RETURNING *, amount::text AS amount_text`).get(row.id);
            return { expired: true, expires_at: isoOf(expired ? expired.expires_at : row.expires_at) };
        }
        const sandbox = isSandbox(row);
        const amount = num(row.amount_text);
        if (sandbox) assertVibesSandbox(ctx.config);
        else {
            assertVibesPay(ctx.config);
            assertAuthority(ctx.config);
            const daily = Number(ctx.config.vibes.dailyAppSpendVibesPerPerson) || 0;
            if (daily <= 0) fail(403, 'billing.vibes_limit_exceeded', 'the daily app spend is closed by the owner');
            const spent = await spentToday(db, person, now);
            if (spent + amount > daily) {
                fail(403, 'billing.vibes_limit_exceeded', `this payment would pass the daily app spend of ${daily} Vibes`, { daily_limit_vibes: daily, spent_vibes: spent, amount });
            }
        }
        const from = payerAccount(sandbox, row.app_id, person);
        const to = projectAccount(sandbox, row.app_id, row.project_id);
        const have = await balance(db, from);
        if (have < amount) fail(402, 'billing.insufficient_vibes', `you have ${have} Vibes, not the ${amount} this charge asks`, { available: have, required: amount });
        const ref = await payerRef(ctx, row.app_id, person);
        const { txn } = await post(ctx, {
            type: 'vibes_charge', idempotencyKey: `vibes:charge:${row.id}`, test: sandbox,
            actor: { type: 'user', id: person }, fromSubject: person, toSubject: null,
            entries: [entry(from, -amount), entry(to, amount)],
            metadata: {
                vibes_charge: 'pay', charge_id: row.id, app_id: row.app_id, project_id: row.project_id,
                amount, description: row.description, payer_ref: ref,
            },
        });
        const updated = await db.prepare(`UPDATE vibes_charges SET status = 'paid', paid_at = ?::timestamptz,
            payer_subject = ?, payer_ref = ?, pay_idempotency_key = ? WHERE id = ? RETURNING *, amount::text AS amount_text`).get(
            iso(now), person, ref, key, row.id);
        const payload = webhookPayload(updated, 'paid');
        await enqueueWebhook(ctx, updated, 'billing.vibes.charge.paid', payload);
        await enqueue(ctx, { event_type: 'billing.vibes.charge.paid', subject: { type: 'vibes-charge', id: row.id }, payload });
        return { charge: presentCharge(updated), vibes_credit: await balance(db, from), replay: false, transaction_id: txn.id };
    });
    if (out.expired) fail(409, 'billing.charge_expired', 'this payment link has expired', { expires_at: out.expires_at });
    return out;
}

/** The pay sheet's read: the charge and app, the item, the person's Vibes and whether they can pay it now. */
async function personCharge(ctx, subject, id) {
    const person = userSubject(subject, 'subject');
    const row = await findCharge(ctx.db, chargeId(id));
    if (!row) fail(404, 'billing.charge_not_found', 'no such payment link');
    const sandbox = isSandbox(row);
    const amount = num(row.amount_text);
    const credit = await balance(ctx.db, payerAccount(sandbox, row.app_id, person));
    const now = ctx.now();
    const expired = row.status === 'pending' && new Date(row.expires_at).getTime() <= now;
    let dailyRemaining = null;
    let canPay = row.status === 'pending' && !expired;
    if (sandbox) canPay = canPay && ctx.config.vibes.sandbox === true;
    else {
        canPay = canPay && ctx.config.vibes.pay === true && ctx.config.authority === 'billing';
        const daily = Number(ctx.config.vibes.dailyAppSpendVibesPerPerson) || 0;
        if (daily <= 0) canPay = false;
        else {
            const spent = await spentToday(ctx.db, person, now);
            dailyRemaining = Math.max(0, daily - spent);
            canPay = canPay && dailyRemaining >= amount;
        }
    }
    canPay = canPay && credit >= amount;
    let app = { id: row.app_id, name: null, icon: null };
    try { app = await ctx.apps.app(row.project_id, row.app_id); } catch { /* the app id is still enough for the sheet */ }
    return {
        charge: presentCharge(row),
        app,
        vibes_credit: credit,
        shortfall_vibes: Math.max(0, amount - credit),
        can_pay: Boolean(canPay),
        expired,
        daily_remaining_vibes: dailyRemaining,
    };
}

/** Cancel a pending charge (a close, no money movement). Paid or refunded charges are never cancelled. */
async function cancelCharge(ctx, subject, id) {
    const person = userSubject(subject, 'subject');
    const cid = chargeId(id);
    await assertNotFrozen(ctx);
    return await money(ctx.db, async () => {
        const db = ctx.db;
        const row = await db.prepare('SELECT *, amount::text AS amount_text FROM vibes_charges WHERE id = ? FOR UPDATE').get(cid);
        if (!row) fail(404, 'billing.charge_not_found', 'no such payment link');
        if (row.status === 'cancelled') return { charge: presentCharge(row), replay: true };
        if (row.status !== 'pending') fail(409, 'billing.charge_not_pending', `this charge is ${row.status}`);
        const now = ctx.now();
        if (new Date(row.expires_at).getTime() <= now) {
            const expired = await db.prepare(`UPDATE vibes_charges SET status = 'expired' WHERE id = ? AND status = 'pending' RETURNING *, amount::text AS amount_text`).get(row.id);
            return { charge: presentCharge(expired), replay: false, expired: true };
        }
        const updated = await db.prepare(`UPDATE vibes_charges SET status = 'cancelled', cancelled_at = ?::timestamptz
            WHERE id = ? AND status = 'pending' RETURNING *, amount::text AS amount_text`).get(iso(now), row.id);
        return { charge: presentCharge(updated), replay: false };
    });
}

/** A sandbox app's own test grant: mint sandbox Vibes into the payer's pocket for that app. */
async function sandboxGrant(ctx, principal, body) {
    const app = requireApp(principal);
    if (app.env !== 'sandbox') fail(403, 'billing.sandbox_app_only', 'only a sandbox app may grant sandbox Vibes');
    assertVibesSandbox(ctx.config);
    await assertNotFrozen(ctx);
    const b = body == null ? {} : body;
    const subject = userSubject(b.subject, 'subject');
    const amount = positiveInt(b.amount, 'amount', MAX_VIBES);
    return await money(ctx.db, async () => {
        const db = ctx.db;
        const now = ctx.now();
        const nowIso = iso(now);
        const issuer = A.vibesSandboxIssuer();
        const target = A.vibesSandbox(app.appId, subject);
        const issuerId = await accountId(db, issuer, nowIso);
        await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(issuerId);
        const targetId = await accountId(db, target, nowIso);
        await db.prepare('SELECT 1 FROM accounts WHERE id = ? FOR UPDATE').get(targetId);
        const grantId = prefixedId('vg', now);
        const { txn } = await post(ctx, {
            type: 'vibes_sandbox_grant', idempotencyKey: `vibes:sandbox:${grantId}`, test: true,
            actor: { type: 'app', id: app.appId }, toSubject: subject,
            entries: [entry(issuer, -amount), entry(target, amount)],
            metadata: { vibes: 'sandbox_grant', grant_id: grantId, app_id: app.appId, project_id: app.projectId, amount },
        });
        return { grant_id: grantId, amount, vibes_credit: await balance(db, target), transaction_id: txn.id };
    });
}

/** GET /api/v1/vibes/me: the person who delegated this app (billing.vibes-wallet@1). */
async function walletForApp(ctx, principal) {
    const app = requireApp(principal);
    if (app.env === 'sandbox') fail(403, 'billing.sandbox_refused', 'a sandbox app reads no real Vibes');
    const person = userSubject(app.onBehalfOf, 'on_behalf_of');
    const out = {
        subject: { type: 'user', id: person }, currency: 'vibes-bits',
        credit: await balance(ctx.db, A.credit(person)),
        payable: await balance(ctx.db, A.payable(person)),
        bits_per_usd: ctx.rates.bitsPerUsd,
    };
    const v = validate('billing.vibes-wallet@1', out);
    if (!v.valid) throw new BillingError(500, 'billing.wallet_invalid', `the wallet does not match its contract: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    return out;
}

module.exports = {
    createCharge, getChargeForApp, refundCharge, payCharge, personCharge, cancelCharge, sandboxGrant, walletForApp,
    presentCharge, webhookPayload, findCharge, CHARGE_ID_RE,
};
