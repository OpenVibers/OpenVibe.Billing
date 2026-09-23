'use strict';

/**
 * Channel subscriptions and the entitlements they grant (ENTITLEMENT, ADR-012).
 *
 * pay() starts or renews a subscription period, paid either
 *   - from credit:    user_credit:<subscriber> −cost → creator_payable:<streamer> +share,
 *                     platform_revenue +rest;
 *   - from a receipt: money received for the sub (Stripe invoice, site-routed PowerChat tip,
 *                     PayPal …) → creator_payable:<streamer> +share of the base price (the
 *                     site-route fee is platform revenue), the rest platform revenue;
 *   - EXTERNAL:       a tip on the streamer's own PowerChat (route 'direct'): the money never
 *                     touched OpenVibe, so the period is granted with no journal entries.
 * The streamer's share is credited on EVERY paid period — first payment and renewals alike.
 *
 * Entitlement truth is the entitlements table: one row per granted period; a subject is
 * entitled to a streamer while a non-revoked row covers now. It needs nothing from Live.
 */
const { post, getTxn, requireFunds, iso, prefixedId } = require('../ledger');
const { enqueue } = require('../outbox');
const { A, entry, receiptEntries, fail, positiveInt } = require('./common');
const { summary } = require('./purchases');
const intents = require('./intents');

const KIND = 'channel_subscription';

function parse(row) { return row ? { ...row, auto_renew: !!row.auto_renew, cancel_at_period_end: !!row.cancel_at_period_end } : null; }
function find(db, id) { return parse(db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)); }
function findPair(db, subscriber, streamer) { return parse(db.prepare('SELECT * FROM subscriptions WHERE subscriber = ? AND streamer = ?').get(subscriber, streamer)); }
function findByProviderRef(db, provider, ref) { return ref ? parse(db.prepare('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ?').get(provider, ref)) : null; }

function present(s) {
    if (!s) return null;
    return {
        id: s.id, subscriber: { type: 'user', id: s.subscriber }, streamer: { type: 'user', id: s.streamer }, tier: s.tier,
        provider: s.provider, provider_ref: s.provider_ref || null, route: s.route || null, status: s.status,
        auto_renew: !!s.auto_renew, cancel_at_period_end: !!s.cancel_at_period_end, price_cents: s.price_cents,
        current_period_end: s.current_period_end, created_at: s.created_at, updated_at: s.updated_at,
    };
}

/** Entitlement of `subject` to `streamer` at `ms`. */
function entitlement(db, subject, streamer, ms) {
    const at = iso(ms);
    const row = db.prepare(`SELECT MAX(ends_at) AS ends_at, MIN(starts_at) AS starts_at FROM entitlements
        WHERE subject = ? AND kind = ? AND scope = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?`).get(subject, KIND, streamer, at, at);
    // Chained future periods (a renewal paid early) extend the expiry.
    let expires = row && row.ends_at;
    if (expires) {
        for (;;) {
            const next = db.prepare(`SELECT MAX(ends_at) AS e FROM entitlements WHERE subject = ? AND kind = ? AND scope = ? AND revoked_at IS NULL
                AND starts_at <= ? AND ends_at > ?`).get(subject, KIND, streamer, expires, expires).e;
            if (!next) break;
            expires = next;
        }
    }
    const sub = findPair(db, subject, streamer);
    return {
        subject: { type: 'user', id: subject }, streamer: { type: 'user', id: streamer }, kind: KIND,
        active: !!expires, expires_at: expires || null,
        subscription: sub ? { id: sub.id, status: sub.status, auto_renew: sub.auto_renew, cancel_at_period_end: sub.cancel_at_period_end, provider: sub.provider } : null,
    };
}

function activeEntitlements(db, subject, ms) {
    const at = iso(ms);
    return db.prepare(`SELECT DISTINCT scope FROM entitlements WHERE subject = ? AND kind = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?`)
        .all(subject, KIND, at, at).map((r) => entitlement(db, subject, r.scope, ms));
}

/**
 * Pay one period. input: { subscriber, streamer, source: 'credit'|'receipt', priceCents?, autoRenew?,
 *   receipt?: { provider, receiptRef, paidCents, feeCents, route, providerRef, test, periodEnd },
 *   intentId?, idempotencyKey, actor, sourceEventId, renewal? }
 */
function pay(ctx, input) {
    const { db, rates } = ctx;
    const { subscriber, streamer } = input;
    if (subscriber === streamer) fail(422, 'billing.self_dealing', 'you cannot subscribe to yourself');
    return db.transaction(() => {
        const existingTxn = db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existingTxn) return result(db, getTxn(db, existingTxn.id), ctx, true);
        if (input.intentId) intents.refuseIfSettledInLive(intents.find(db, input.intentId));
        const r = input.receipt;
        if (r) {
            const dup = db.prepare('SELECT id FROM transactions WHERE receipt_ref = ?').get(r.receiptRef);
            if (dup) return { ...result(db, getTxn(db, dup.id), ctx, true), duplicateReceipt: true };
        }
        const ms = ctx.now();
        const priceCents = input.priceCents != null ? positiveInt(input.priceCents, 'price_cents', 10_000_000) : rates.subPriceCents;
        const prior = findPair(db, subscriber, streamer);

        let entries = [];
        let provider = 'credit';
        let meta;
        let route = null;
        if (input.source === 'credit') {
            const cost = rates.bitsForValueCents(priceCents);
            const share = Math.min(cost, rates.subShareBits(priceCents));
            requireFunds(db, A.credit(subscriber), cost, 'credit');
            entries = [entry(A.credit(subscriber), -cost), entry(A.payable(streamer), share), entry(A.revenue('vibes-bits'), cost - share)];
            meta = { source: 'credit', price_cents: priceCents, cost_bits: cost, share_bits: share, sub_share_pct: rates.subSharePct };
        } else if (input.source === 'receipt' && r) {
            provider = r.provider;
            route = r.route || null;
            const paid = positiveInt(r.paidCents, 'amount_cents', 100_000_000);
            const fee = Math.max(0, Math.round(Number(r.feeCents) || 0));
            if (route === 'direct') {
                // EXTERNAL: the streamer holds the money already; nothing touches the journal.
                meta = { source: 'external', route, paid_cents: paid, external: true };
            } else {
                const base = Math.max(0, paid - fee);
                const share = rates.subShareBits(base);
                entries = receiptEntries(rates, { provider, paidCents: paid, bits: share, target: A.payable(streamer) });
                meta = { source: 'receipt', route, paid_cents: paid, fee_cents: fee, share_base_cents: base, share_bits: share, sub_share_pct: rates.subSharePct };
            }
        } else {
            fail(422, 'billing.invalid_input', "source must be 'credit' or 'receipt' (with a receipt)");
        }

        // Period: starts now, or at the end of a still-running period (an early renewal).
        const running = prior && prior.current_period_end && Date.parse(prior.current_period_end) > ms ? Date.parse(prior.current_period_end) : ms;
        const start = running;
        const end = r && r.periodEnd ? Math.max(Date.parse(r.periodEnd), start + 1) : start + rates.subPeriodDays * 86_400_000;
        const renewal = !!(prior && (prior.status === 'active' || input.renewal));

        const { txn } = post(ctx, {
            type: 'subscription',
            idempotencyKey: input.idempotencyKey,
            entries,
            test: !!(r && r.test),
            actor: input.actor,
            fromSubject: subscriber,
            toSubject: streamer,
            provider: r ? r.provider : null,
            receiptRef: r ? r.receiptRef : null,
            sourceEventId: input.sourceEventId,
            metadata: { ...meta, renewal, period_start: iso(start), period_end: iso(end), intent_id: input.intentId || null, rates: rates.snapshot() },
        });

        const nowIso = iso(ms);
        const autoRenew = input.autoRenew != null ? (input.autoRenew ? 1 : 0) : (prior ? (prior.auto_renew ? 1 : 0) : (input.source === 'credit' ? 1 : 0));
        let sub;
        if (prior) {
            db.prepare(`UPDATE subscriptions SET provider = ?, provider_ref = COALESCE(?, provider_ref), route = ?, status = 'active', auto_renew = ?,
                    cancel_at_period_end = 0, price_cents = ?, current_period_end = ?, updated_at = ? WHERE id = ?`)
                .run(provider, r ? r.providerRef || null : null, route, autoRenew, priceCents, iso(end), nowIso, prior.id);
            sub = find(db, prior.id);
        } else {
            const id = prefixedId('sub', ms);
            db.prepare(`INSERT INTO subscriptions (id, subscriber, streamer, tier, provider, provider_ref, route, status, auto_renew, cancel_at_period_end,
                    price_cents, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)`)
                .run(id, subscriber, streamer, provider, r ? r.providerRef || null : null, route, autoRenew, priceCents, iso(end), nowIso, nowIso);
            sub = find(db, id);
        }
        db.prepare(`INSERT INTO entitlements (id, subject, kind, scope, subscription_id, starts_at, ends_at, source_txn, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(prefixedId('ent', ms), subscriber, KIND, streamer, sub.id, iso(start), iso(end), txn.id, nowIso);
        if (input.intentId) intents.markSettled(ctx, input.intentId, txn.id);

        if (txn.entries.length) enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn) });
        enqueue(ctx, {
            event_type: 'billing.entitlement.changed', subject: { type: 'entitlement', id: `${subscriber}:${KIND}:${streamer}` },
            payload: { ...entitlement(db, subscriber, streamer, ms), reason: renewal ? 'renewed' : 'granted', transaction_id: txn.id },
        });
        return result(db, txn, ctx, false);
    })();
}

function result(db, txn, ctx, replay) {
    const ent = db.prepare('SELECT * FROM entitlements WHERE source_txn = ?').get(txn.id);
    const sub = ent ? find(db, ent.subscription_id) : null;
    return { txn, subscription: sub, entitlement: sub ? entitlement(db, sub.subscriber, sub.streamer, ctx.now()) : null, replay };
}

/**
 * Cancel at period end. Stripe subscriptions are cancelled AT STRIPE through the adapter first
 * (Live only flipped a local flag and Stripe kept billing); if Stripe refuses, nothing changes.
 */
async function cancel(ctx, { id, actor }, adapters) {
    const { db } = ctx;
    const sub = find(db, id);
    if (!sub) fail(404, 'billing.subscription_not_found', `no subscription ${id}`);
    if (sub.status !== 'active') return { subscription: sub, provider_sync: 'not_needed', replay: true };
    let providerSync = 'not_needed';
    if (sub.provider === 'stripe') {
        const stripe = adapters && adapters.stripe;
        if (!stripe || !stripe.enabled) fail(409, 'billing.provider_disabled', 'the Stripe adapter is disabled; cancelling here alone would leave Stripe billing the subscriber');
        if (!sub.provider_ref) fail(409, 'billing.provider_ref_missing', 'this Stripe subscription has no Stripe id to cancel');
        try { await stripe.cancelAtPeriodEnd(sub.provider_ref); }
        catch (e) { fail(502, 'billing.provider_error', `Stripe refused the cancellation: ${e.message}`); }
        providerSync = 'stripe_cancel_at_period_end';
    }
    db.transaction(() => {
        db.prepare('UPDATE subscriptions SET cancel_at_period_end = 1, auto_renew = 0, updated_at = ? WHERE id = ?').run(iso(ctx.now()), id);
        enqueue(ctx, {
            event_type: 'billing.subscription.canceled', subject: { type: 'subscription', id },
            payload: { subscription: present(find(db, id)), provider_sync: providerSync, actor },
        });
    })();
    return { subscription: find(db, id), provider_sync: providerSync, replay: false };
}

function setStatus(ctx, id, status, reason) {
    const { db } = ctx;
    const sub = find(db, id);
    if (!sub || sub.status === status) return sub;
    db.prepare('UPDATE subscriptions SET status = ?, auto_renew = CASE WHEN ? = \'active\' THEN auto_renew ELSE 0 END, updated_at = ? WHERE id = ?')
        .run(status, status, iso(ctx.now()), id);
    enqueue(ctx, {
        event_type: 'billing.entitlement.changed', subject: { type: 'entitlement', id: `${sub.subscriber}:${KIND}:${sub.streamer}` },
        payload: { ...entitlement(db, sub.subscriber, sub.streamer, ctx.now()), reason: reason || status },
    });
    return find(db, id);
}

/** Revoke the periods a reversed payment granted. Returns the number of periods revoked. */
function revokeForTxn(ctx, txnId, reason) {
    const { db } = ctx;
    const ents = db.prepare('SELECT * FROM entitlements WHERE source_txn = ? AND revoked_at IS NULL').all(txnId);
    if (!ents.length) return 0;
    const at = iso(ctx.now());
    for (const e of ents) {
        db.prepare('UPDATE entitlements SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(at, reason, e.id);
        const sub = find(db, e.subscription_id);
        if (sub) {
            const left = db.prepare('SELECT MAX(ends_at) AS e FROM entitlements WHERE subscription_id = ? AND revoked_at IS NULL').get(sub.id).e;
            const stillActive = left && Date.parse(left) > ctx.now();
            db.prepare('UPDATE subscriptions SET current_period_end = ?, status = ?, auto_renew = CASE WHEN ? THEN auto_renew ELSE 0 END, updated_at = ? WHERE id = ?')
                .run(left || at, stillActive ? sub.status : 'expired', stillActive ? 1 : 0, at, sub.id);
        }
        enqueue(ctx, {
            event_type: 'billing.entitlement.changed', subject: { type: 'entitlement', id: `${e.subject}:${KIND}:${e.scope}` },
            payload: { ...entitlement(db, e.subject, e.scope, ctx.now()), reason, revoked_period: { starts_at: e.starts_at, ends_at: e.ends_at } },
        });
    }
    return ents.length;
}

/**
 * Renewal sweep (hourly job). For every active subscription whose period ended:
 *   - Stripe: Stripe renews itself (invoice.paid); expire only after the grace window;
 *   - cancel-at-period-end / no auto-renew: end it;
 *   - otherwise renew from the subscriber's credit (deterministic key per period), or end it
 *     when the credit does not cover the price.
 */
function sweep(ctx, { limit = 200 } = {}) {
    const { db, rates } = ctx;
    const out = { renewed: [], expired: [], canceled: [], skipped: 0 };
    const now = ctx.now();
    const due = db.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND current_period_end IS NOT NULL AND current_period_end <= ? ORDER BY current_period_end LIMIT ?")
        .all(iso(now), limit).map(parse);
    for (const sub of due) {
        const end = Date.parse(sub.current_period_end);
        if (sub.provider === 'stripe') {
            if (now - end < rates.stripeGraceDays * 86_400_000) { out.skipped++; continue; }
            setStatus(ctx, sub.id, 'expired', 'stripe_not_renewed'); out.expired.push(sub.id); continue;
        }
        if (sub.cancel_at_period_end || !sub.auto_renew) {
            const st = sub.cancel_at_period_end ? 'canceled' : 'expired';
            setStatus(ctx, sub.id, st, st); (st === 'canceled' ? out.canceled : out.expired).push(sub.id); continue;
        }
        try {
            pay(ctx, {
                subscriber: sub.subscriber, streamer: sub.streamer, source: 'credit', priceCents: sub.price_cents || rates.subPriceCents,
                autoRenew: true, renewal: true, idempotencyKey: `renew:${sub.id}:${sub.current_period_end}`,
                actor: { principal: 'svc:billing', job: 'renewal-sweep' },
            });
            out.renewed.push(sub.id);
        } catch (e) {
            if (e.code !== 'billing.insufficient_funds') throw e;
            setStatus(ctx, sub.id, 'expired', 'renewal_insufficient_credit'); out.expired.push(sub.id);
        }
    }
    return out;
}

function list(db, { subscriber, streamer, status } = {}) {
    const where = [];
    const args = [];
    if (subscriber) { where.push('subscriber = ?'); args.push(subscriber); }
    if (streamer) { where.push('streamer = ?'); args.push(streamer); }
    if (status) { where.push('status = ?'); args.push(status); }
    return db.prepare(`SELECT * FROM subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`).all(...args).map(parse);
}

module.exports = { pay, cancel, sweep, entitlement, activeEntitlements, revokeForTxn, setStatus, find, findPair, findByProviderRef, list, present, KIND };
