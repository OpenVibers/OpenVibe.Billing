'use strict';

/**
 * /api/v1 — the operations API. Service tokens only (audience openvibe.billing); Live is the
 * first client. Every mutating call needs an Idempotency-Key — except POST /api/v1/usage,
 * which is keyed by the reading's own idempotency_key — and is refused with 503
 * billing.frozen while the economy is frozen (reads keep working).
 *
 * Amounts are integers: bits for Vibes (vibes-bits), cents for money (usd-cents). People are
 * Network SubjectRefs ({ type: 'user', id: 'usr_…' }); path parameters take the bare subject id.
 */
const express = require('express');
const { http, capabilities } = require('openvibe-contracts');
const { getTxn, present: presentTxn, balance, BillingError, money } = require('../ledger');
const { A, userSubject, positiveInt, isFrozen, fail } = require('../ops/common');
const { idempotent } = require('./idempotency');
const { actorOf } = require('./auth');
const { personOf } = require('./actor-limits');
const purchases = require('../ops/purchases');
const transfers = require('../ops/transfers');
const cashouts = require('../ops/cashouts');
const subscriptions = require('../ops/subscriptions');
const intents = require('../ops/intents');
const admin = require('../ops/admin');
const providers = require('../providers');
const { reconcile } = require('../reconcile');
const external = require('../ops/external');
const usage = require('../ops/usage');

const CAP = {
    intent: 'billing.intent.create',
    transfer: 'billing.transfer.create',
    balance: 'billing.balance.read',
    cashoutRequest: 'billing.cashout.request',
    cashoutManage: 'billing.cashout.manage',
    subscription: 'billing.subscription.manage',
    entitlement: 'billing.entitlement.check',
    admin: 'billing.ledger.admin',
    usage: 'billing.usage.record',
};

function v1Router({ ctx, auth, adapters, limits }) {
    const r = express.Router();
    const { db } = ctx;
    const idem = idempotent(db, ctx.now);
    const notFrozen = async (req, res, next) => (await isFrozen(db)
        ? http.sendProblem(res, 503, 'billing.frozen', { detail: 'the economy is frozen: writes are refused, reads are served', ctx: req.ov })
        : next());
    /**
     * A mutating route: capability → freeze → per-person limit (when given) → idempotency → handler.
     * A limit refusal reaches neither the idempotency store nor the ledger; a frozen refusal is not counted.
     */
    const write = (cap, handler, limit) => [auth.needs(cap), notFrozen, ...(limit ? [limit] : []), idem, wrap(handler)];
    const read = (cap, handler, limit) => [auth.needs(cap), ...(limit ? [limit] : []), wrap(handler)];
    // Who a money route is counted against (api/actor-limits.js): the person the body names.
    const person = (field) => (req) => personOf(req.body && req.body[field]);
    const txnOut = (t, extra = {}) => ({ transaction: presentTxn(t), ...extra });
    const pathSubject = (v) => userSubject(String(v), 'subject');

    // ── Rates (public: prices the UI shows) ──────────────────
    r.get('/rates', (req, res) => {
        const rt = ctx.rates;
        res.json({
            currency: 'vibes-bits', bits_per_usd: rt.bitsPerUsd, price_tiers: rt.priceTiers, min_purchase_bits: rt.minPurchaseBits,
            packages: [100, 500, 1000, 2500, 5000, 10000, 25000].map((bits) => ({ bits, price_cents: rt.priceCents(bits) })),
            subscription: { price_cents: rt.subPriceCents, streamer_share_pct: rt.subSharePct, site_route_fee_pct: rt.siteRouteFeePct, period_days: rt.subPeriodDays },
            cashout: { min_bits: rt.minCashoutBits, escrow_days: rt.escrowDays },
            providers: Object.fromEntries(Object.values(adapters).map((a) => [a.name, a.enabled])),
        });
    });

    // ── Checkout intents ─────────────────────────────────────
    r.post('/intents', ...write(CAP.intent, async (req, res) => {
        const b = req.body || {};
        const adapter = adapters[String(b.provider || '').toLowerCase()];
        if (!adapter) fail(422, 'billing.invalid_input', `unknown provider ${b.provider}`);
        if (!adapter.enabled) fail(409, 'billing.provider_disabled', `${adapter.name} is not enabled on Billing`);
        const intent = await intents.create(ctx, b);
        let checkoutUrl = null;
        if (adapter.createCheckout) {
            const name = intent.kind === 'purchase' ? `${intent.bits.toLocaleString('en-US')} Vibes` : 'Channel subscription (1 month)';
            try {
                const out = await adapter.createCheckout(ctx, intent, {
                    name, successUrl: b.success_url || `${ctx.config.baseUrl}/checkout/success`, cancelUrl: b.cancel_url || `${ctx.config.baseUrl}/checkout/cancel`,
                    ipnUrl: `${ctx.config.baseUrl}/webhooks/${adapter.name}`,
                });
                if (out.providerRef) await intents.setProviderRef(ctx, intent.id, out.providerRef);
                checkoutUrl = out.url || null;
            } catch (e) {
                await intents.setStatus(ctx, intent.id, 'failed');
                fail(502, 'billing.provider_error', `${adapter.name}: ${e.message}`);
            }
        }
        res.status(201).json({ intent: intents.present(await intents.find(db, intent.id)), checkout_url: checkoutUrl });
    }, limits.budget('billing.intent.create', person('subject'))));
    r.get('/intents/:id', ...read(CAP.intent, async (req, res) => {
        const i = await intents.find(db, req.params.id);
        if (!i) fail(404, 'billing.intent_not_found', `no intent ${req.params.id}`);
        res.json({ intent: intents.present(i) });
    }));
    r.post('/intents/:id/capture', ...write(CAP.intent, async (req, res) => {
        const i = await intents.find(db, req.params.id);
        if (!i) fail(404, 'billing.intent_not_found', `no intent ${req.params.id}`);
        const adapter = adapters[i.provider];
        if (!adapter || !adapter.capture || !adapter.enabled) fail(409, 'billing.provider_disabled', `${i.provider} has no enabled capture`);
        const plan = await adapter.capture(ctx, i);
        const result = await money(db, async () => await providers.applyPlan(ctx, plan, { id: null }));
        res.json({ result, intent: intents.present(await intents.find(db, i.id)) });
    }));

    // ── Purchases: settle a provider receipt (operator/reconciler grade) ──
    r.post('/purchases/settle', ...write(CAP.admin, async (req, res) => {
        const b = req.body || {};
        if (!b.provider || !b.provider_ref) fail(422, 'billing.invalid_input', 'provider and provider_ref (the provider payment id) are required');
        const out = await purchases.settle(ctx, {
            provider: String(b.provider).toLowerCase(), receiptRef: `${String(b.provider).toLowerCase()}:${b.provider_ref}`,
            subject: b.subject ? userSubject(b.subject) : null, paidCents: b.amount_cents, bits: b.bits, intentId: b.intent_id,
            test: !!b.test, idempotencyKey: req.idempotencyKey, actor: actorOf(req), traceId: req.ov.traceId,
        });
        res.status(out.replay ? 200 : 201).json(txnOut(out.txn, { duplicate_receipt: !!out.duplicateReceipt }));
    }));

    // ── Transfers (tips / donations / paid interactions) ─────
    r.post('/transfers', ...write(CAP.transfer, async (req, res) => {
        const b = req.body || {};
        const out = await transfers.create(ctx, {
            from: userSubject(b.from, 'from'), to: userSubject(b.to, 'to'), amount: b.amount, kind: b.kind, target: b.target,
            message: b.message, idempotencyKey: req.idempotencyKey, actor: actorOf(req), traceId: req.ov.traceId,
        });
        res.status(201).json(txnOut(out.txn, { balance: { credit: await balance(db, A.credit(out.txn.from_subject)) } }));
    }, limits.budget('billing.transfer.create', person('from'))));
    r.post('/transfers/:id/refund', ...write(CAP.transfer, async (req, res) => {
        const b = req.body || {};
        const out = await transfers.refund(ctx, { txnId: req.params.id, amount: b.amount, reason: b.reason, idempotencyKey: req.idempotencyKey, actor: actorOf(req) });
        res.status(201).json(txnOut(out.txn));
    }, limits.budget('billing.transfer.refund', limits.payerOf)));

    // ── Recycle: creator payable → own spendable credit ──────
    r.post('/recycle', ...write(CAP.cashoutRequest, async (req, res) => {
        const b = req.body || {};
        const subject = userSubject(b.subject);
        const out = await cashouts.recycle(ctx, { subject, amount: b.amount, idempotencyKey: req.idempotencyKey, actor: actorOf(req) });
        res.status(201).json(txnOut(out.txn, { balance: await balanceOf(subject) }));
    }, limits.budget('billing.recycle', person('subject'))));

    // ── Cashouts ─────────────────────────────────────────────
    r.post('/cashouts', ...write(CAP.cashoutRequest, async (req, res) => {
        const b = req.body || {};
        const out = await cashouts.request(ctx, { subject: userSubject(b.subject), amount: b.amount, payout_method: b.payout_method, idempotencyKey: req.idempotencyKey, actor: actorOf(req) });
        res.status(201).json({ cashout: cashouts.present(out.cashout) });
    }, limits.budget('billing.cashout.request', person('subject'))));
    r.get('/cashouts', ...read(CAP.cashoutManage, async (req, res) => {
        const list = await cashouts.list(db, { status: req.query.status, subject: req.query.subject, limit: Number(req.query.limit) || 100 });
        res.json({ cashouts: list.map(cashouts.present) });
    }));
    r.get('/cashouts/:id', ...read([CAP.cashoutManage, CAP.cashoutRequest], async (req, res) => {
        const c = await cashouts.find(db, req.params.id);
        if (!c) fail(404, 'billing.cashout_not_found', `no cashout ${req.params.id}`);
        res.json({ cashout: cashouts.present(c) });
    }));
    r.post('/cashouts/:id/approve', ...write(CAP.cashoutManage, async (req, res) => {
        const b = req.body || {};
        const out = await cashouts.approve(ctx, { id: req.params.id, payout_reference: b.payout_reference, payout_provider: b.payout_provider, idempotencyKey: req.idempotencyKey, actor: actorOf(req) });
        res.json({ cashout: cashouts.present(out.cashout) });
    }));
    r.post('/cashouts/:id/deny', ...write(CAP.cashoutManage, async (req, res) => {
        const out = await cashouts.deny(ctx, { id: req.params.id, reason: (req.body || {}).reason, idempotencyKey: req.idempotencyKey, actor: actorOf(req) });
        res.json({ cashout: cashouts.present(out.cashout) });
    }));

    // ── Subscriptions and entitlements ───────────────────────
    r.post('/subscriptions', ...write(CAP.subscription, async (req, res) => {
        const b = req.body || {};
        const source = b.source || 'credit';
        let receipt = null;
        if (source === 'receipt') {
            // Claiming money was received is operator grade; providers normally settle through webhooks.
            if (!capabilities.grants(req.principal.cap, CAP.admin)) {
                fail(403, 'capability.denied', `a receipt-paid subscription through the API needs ${CAP.admin}`);
            }
            const rc = b.receipt || {};
            if (!rc.provider || !rc.provider_ref) fail(422, 'billing.invalid_input', 'receipt.provider and receipt.provider_ref are required');
            const provider = String(rc.provider).toLowerCase();
            receipt = { provider, receiptRef: `${provider}:${rc.provider_ref}`, paidCents: rc.amount_cents, feeCents: rc.fee_cents, route: rc.route, providerRef: rc.subscription_ref || null, test: !!rc.test };
        }
        const out = await subscriptions.pay(ctx, {
            subscriber: userSubject(b.subscriber, 'subscriber'), streamer: userSubject(b.streamer, 'streamer'), source,
            priceCents: b.price_cents, autoRenew: b.auto_renew, receipt, idempotencyKey: req.idempotencyKey, actor: actorOf(req),
        });
        res.status(201).json({ subscription: subscriptions.present(out.subscription), entitlement: out.entitlement, transaction: presentTxn(out.txn) });
    }, limits.budget('billing.subscription.create', person('subscriber'))));
    r.get('/subscriptions', ...read([CAP.entitlement, CAP.subscription], async (req, res) => {
        const list = await subscriptions.list(db, {
            subscriber: req.query.subscriber ? pathSubject(req.query.subscriber) : null,
            streamer: req.query.streamer ? pathSubject(req.query.streamer) : null,
            status: req.query.status || null,
        });
        res.json({ subscriptions: list.map(subscriptions.present) });
    }));
    r.get('/subscriptions/:id', ...read([CAP.entitlement, CAP.subscription], async (req, res) => {
        const s = await subscriptions.find(db, req.params.id);
        if (!s) fail(404, 'billing.subscription_not_found', `no subscription ${req.params.id}`);
        res.json({ subscription: subscriptions.present(s), entitlement: await subscriptions.entitlement(db, s.subscriber, s.streamer, ctx.now()) });
    }));
    r.post('/subscriptions/:id/cancel', ...write(CAP.subscription, async (req, res) => {
        const out = await subscriptions.cancel(ctx, { id: req.params.id, actor: actorOf(req) }, adapters);
        res.json({ subscription: subscriptions.present(out.subscription), provider_sync: out.provider_sync });
    }));
    r.get('/entitlements/:subject', ...read(CAP.entitlement, async (req, res) => {
        const subject = pathSubject(req.params.subject);
        if (req.query.streamer) return res.json(await subscriptions.entitlement(db, subject, pathSubject(req.query.streamer), ctx.now()));
        return res.json({ subject: { type: 'user', id: subject }, entitlements: await subscriptions.activeEntitlements(db, subject, ctx.now()) });
    }));

    // ── Balances and history ─────────────────────────────────
    async function balanceOf(subject) {
        const credit = await balance(db, A.credit(subject));
        const payable = await balance(db, A.payable(subject));
        const pending = await balance(db, A.pending(subject));
        return {
            subject: { type: 'user', id: subject }, currency: 'vibes-bits', credit, payable, pending_payouts: pending,
            payable_value_cents: ctx.rates.valueCents(payable), bits_per_usd: ctx.rates.bitsPerUsd,
        };
    }
    r.get('/balances/:subject', ...read(CAP.balance, async (req, res) => res.json(await balanceOf(pathSubject(req.params.subject)))));

    r.get('/transactions', ...read(CAP.balance, async (req, res) => {
        const subject = req.query.subject ? pathSubject(req.query.subject) : null;
        if (!subject) fail(422, 'billing.invalid_input', 'subject is required');
        const limit = Math.min(200, positiveInt(req.query.limit || 50, 'limit'));
        let cur = null;
        if (req.query.cursor) {
            try { cur = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8')); } catch { fail(422, 'billing.invalid_input', 'bad cursor'); }
        }
        const rows = await db.prepare(`SELECT t.id, t.created_at FROM transactions t
            WHERE (t.from_subject = @s OR t.to_subject = @s OR t.id IN (SELECT e.txn_id FROM ledger_entries e JOIN accounts a ON a.id = e.account_id WHERE a.owner_subject = @s))
              AND (@c::text IS NULL OR t.created_at < @c::text OR (t.created_at = @c::text AND t.id < @i::text))
            ORDER BY t.created_at DESC, t.id DESC LIMIT @n`).all({ s: subject, c: cur ? cur[0] : null, i: cur ? cur[1] : null, n: limit + 1 });
        const page = rows.slice(0, limit);
        const next = rows.length > limit ? Buffer.from(JSON.stringify([page[page.length - 1].created_at, page[page.length - 1].id])).toString('base64url') : null;
        res.json({ transactions: (await Promise.all(page.map(async (x) => presentTxn(await getTxn(db, x.id))))), next_cursor: next });
    }, limits.history));
    r.get('/transactions/:id', ...read(CAP.balance, async (req, res) => {
        const t = await getTxn(db, req.params.id);
        if (!t) fail(404, 'billing.transaction_not_found', `no transaction ${req.params.id}`);
        const reversals = (await db.prepare('SELECT id FROM transactions WHERE reverses_txn = ? ORDER BY created_at').all(t.id)).map((x) => x.id);
        res.json({ transaction: presentTxn(t), reversed_by: reversals });
    }));

    // ── Usage readings (platform.usage-sample@1; ops/usage.js) ──
    // Stored and reported, never charged. Not a money movement, so accepted while frozen; idempotent by the
    // reading's own idempotency_key (no Idempotency-Key header): a replay is 200 with the stored row, a new one 201.
    r.post('/usage', auth.needs(CAP.usage), wrap(async (req, res) => {
        const out = await usage.record(ctx, req.body, { principal: req.principal.sub });
        if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(out.replayed ? 200 : 201).json({ record: out.record });
    }));
    r.get('/usage', ...read(CAP.admin, async (req, res) => res.json(await usage.list(db, req.query))));

    // ── Admin (billing.ledger.admin) ─────────────────────────
    r.get('/admin/freeze', ...read(CAP.admin, async (req, res) => res.json(await admin.freezeState(db))));
    r.post('/admin/freeze', auth.needs(CAP.admin), wrap(async (req, res) => {
        const b = req.body || {};
        if (typeof b.on !== 'boolean') fail(422, 'billing.invalid_input', 'on must be true or false');
        const state = await admin.setFreeze(ctx, { on: b.on, reason: b.reason, actor: actorOf(req) });
        // Deliveries stored while frozen are processed now, in arrival order.
        const drained = b.on ? null : await providers.processPending(ctx, adapters);
        res.json({ ...state, processed_after_unfreeze: drained });
    }));
    r.get('/admin/reconcile', ...read(CAP.admin, async (req, res) => {
        const report = await reconcile(ctx, { trigger: 'api' });
        res.status(200).json(report);
    }));
    // Stored runs (scheduled and on demand), newest first; ?failed=1 for failed runs only.
    r.get('/admin/reconciliations', ...read(CAP.admin, async (req, res) => {
        const limit = Math.min(200, positiveInt(req.query.limit || 20, 'limit'));
        const failed = req.query.failed === '1' || req.query.failed === 'true';
        const rows = await db.prepare(`SELECT id, started_at, finished_at, ok, report FROM reconciliation_runs ${failed ? 'WHERE ok = 0' : ''} ORDER BY finished_at DESC, id DESC LIMIT ?`).all(limit);
        res.json({
            runs: rows.map((r) => {
                const rep = JSON.parse(r.report);
                return { id: r.id, ok: !!r.ok, trigger: rep.trigger || null, started_at: r.started_at, finished_at: r.finished_at, failed_checks: rep.checks.filter((c) => !c.ok).map((c) => c.id) };
            }),
        });
    }));
    r.get('/admin/reconciliations/:id', ...read(CAP.admin, async (req, res) => {
        const row = req.params.id === 'latest'
            ? await db.prepare('SELECT report FROM reconciliation_runs ORDER BY finished_at DESC, id DESC LIMIT 1').get()
            : await db.prepare('SELECT report FROM reconciliation_runs WHERE id = ?').get(req.params.id);
        if (!row) fail(404, 'billing.reconciliation_not_found', `no reconciliation run ${req.params.id}`);
        res.json(JSON.parse(row.report));
    }));
    // Provider account → creator (who an EXTERNAL tip on that account belongs to).
    r.get('/admin/provider-accounts', ...read(CAP.admin, async (req, res) => {
        res.json({ accounts: await db.prepare('SELECT * FROM provider_accounts ORDER BY provider, username').all() });
    }));
    // Not a money movement: allowed while frozen (the cutover maps accounts with Billing frozen).
    r.post('/admin/provider-accounts', auth.needs(CAP.admin), idem, wrap(async (req, res) => {
        const b = req.body || {};
        const provider = String(b.provider || '').toLowerCase();
        if (!adapters[provider]) fail(422, 'billing.invalid_input', `provider must be one of ${Object.keys(adapters).join(', ')}`);
        const row = await external.mapAccount(ctx, { provider, username: b.username, accountId: b.account_id, subject: b.subject, source: 'admin' });
        res.status(201).json({ account: row });
    }));
    r.post('/admin/adjustments', ...write(CAP.admin, async (req, res) => {
        const b = req.body || {};
        const out = await admin.adjust(ctx, { from: b.from, to: b.to, amount: b.amount, reason: b.reason, relatesTo: b.relates_to, idempotencyKey: req.idempotencyKey, actor: actorOf(req) });
        res.status(201).json(txnOut(out.txn));
    }));
    r.get('/admin/provider-events', ...read(CAP.admin, async (req, res) => {
        const pending = req.query.pending === '1' || req.query.pending === 'true';
        const rows = (await db.prepare(`SELECT * FROM provider_events ${pending ? 'WHERE processed_at IS NULL' : ''} ORDER BY id DESC LIMIT 200`).all()).map(providers.parseRow);
        res.json({ events: rows.map(providers.present) });
    }));
    r.post('/admin/provider-events/:id/reprocess', auth.needs(CAP.admin), notFrozen, wrap(async (req, res) => {
        const row = await providers.reprocess(ctx, adapters, Number(req.params.id));
        res.json({ event: providers.present(row) });
    }));
    r.post('/admin/sweep', auth.needs(CAP.admin), notFrozen, wrap(async (req, res) => res.json(await subscriptions.sweep(ctx))));
    r.get('/admin/import-holds', ...read(CAP.admin, async (req, res) => res.json({ holds: await db.prepare('SELECT * FROM import_holds ORDER BY live_user_id').all() })));

    return r;
}

/** Async-safe handler: BillingError → problem+json; anything else → 500. */
function wrap(fn) {
    return async (req, res, next) => {
        try {
            const p = await fn(req, res, next);
            if (p && typeof p.catch === 'function') p.catch((e) => sendError(req, res, e));
        } catch (e) { sendError(req, res, e); }
    };
}

function sendError(req, res, e) {
    if (res.headersSent) return;
    if (e instanceof BillingError) {
        return http.sendProblem(res, e.status, e.code, { detail: e.detail || e.message, ctx: req.ov, extra: e.extra && e.status < 500 ? { details: e.extra } : undefined });
    }
    console.error('[Billing] unexpected error:', e);
    return http.sendProblem(res, 500, 'billing.internal', { detail: 'internal error', ctx: req.ov });
}

module.exports = { v1Router, wrap, sendError, CAP };
