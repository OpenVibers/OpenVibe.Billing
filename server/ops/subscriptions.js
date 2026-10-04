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
 *
 * A credit renewal the subscriber cannot pay leaves the subscription past_due for
 * BILLING_RENEWAL_GRACE_DAYS (0 = end it at once): no period covers the grace, so the entitlement
 * is not active, and the sweep retries the same charge under the same key until it is paid or
 * grace_until passes.
 */
const { post, getTxn, requireFunds, iso, prefixedId, money } = require('../ledger');
const { enqueue } = require('../outbox');
const { A, MAX_RECEIPT_CENTS, entry, receiptEntries, fail, positiveInt } = require('./common');
const { summary } = require('./purchases');
const intents = require('./intents');

const KIND = 'channel_subscription';

function parse(row) { return row ? { ...row, auto_renew: !!row.auto_renew, cancel_at_period_end: !!row.cancel_at_period_end, renewal_attempts: Number(row.renewal_attempts) || 0 } : null; }
async function find(db, id) { return parse(await db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id)); }
async function findPair(db, subscriber, streamer) { return parse(await db.prepare('SELECT * FROM subscriptions WHERE subscriber = ? AND streamer = ?').get(subscriber, streamer)); }
async function findByProviderRef(db, provider, ref) { return ref ? parse(await db.prepare('SELECT * FROM subscriptions WHERE provider = ? AND provider_ref = ?').get(provider, ref)) : null; }

function present(s) {
    if (!s) return null;
    return {
        id: s.id, subscriber: { type: 'user', id: s.subscriber }, streamer: { type: 'user', id: s.streamer }, tier: s.tier,
        provider: s.provider, provider_ref: s.provider_ref || null, route: s.route || null, status: s.status,
        auto_renew: !!s.auto_renew, cancel_at_period_end: !!s.cancel_at_period_end, price_cents: s.price_cents,
        current_period_end: s.current_period_end, grace_until: s.grace_until || null, renewal_failed_at: s.renewal_failed_at || null,
        renewal_attempts: Number(s.renewal_attempts) || 0, created_at: s.created_at, updated_at: s.updated_at,
    };
}

/** Entitlement of `subject` to `streamer` at `ms`. */
async function entitlement(db, subject, streamer, ms) {
    const at = iso(ms);
    const row = await db.prepare(`SELECT MAX(ends_at) AS ends_at, MIN(starts_at) AS starts_at FROM entitlements
        WHERE subject = ? AND kind = ? AND scope = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?`).get(subject, KIND, streamer, at, at);
    // Chained future periods (a renewal paid early) extend the expiry.
    let expires = row && row.ends_at;
    if (expires) {
        for (;;) {
            const next = (await db.prepare(`SELECT MAX(ends_at) AS e FROM entitlements WHERE subject = ? AND kind = ? AND scope = ? AND revoked_at IS NULL
                AND starts_at <= ? AND ends_at > ?`).get(subject, KIND, streamer, expires, expires)).e;
            if (!next) break;
            expires = next;
        }
    }
    const sub = await findPair(db, subject, streamer);
    return {
        subject: { type: 'user', id: subject }, streamer: { type: 'user', id: streamer }, kind: KIND,
        active: !!expires, expires_at: expires || null,
        // past_due: when the sweep stops retrying the renewal. The grace grants no access (active stays false).
        grace_until: sub && sub.status === 'past_due' ? sub.grace_until || null : null,
        subscription: sub ? { id: sub.id, status: sub.status, auto_renew: sub.auto_renew, cancel_at_period_end: sub.cancel_at_period_end, provider: sub.provider } : null,
    };
}

async function activeEntitlements(db, subject, ms) {
    const at = iso(ms);
    return (await Promise.all((await db.prepare(`SELECT DISTINCT scope FROM entitlements WHERE subject = ? AND kind = ? AND revoked_at IS NULL AND starts_at <= ? AND ends_at > ?`)
        .all(subject, KIND, at, at)).map(async (r) => await entitlement(db, subject, r.scope, ms))));
}

/**
 * Pay one period. input: { subscriber, streamer, source: 'credit'|'receipt', priceCents?, autoRenew?,
 *   receipt?: { provider, receiptRef, paidCents, feeCents, route, providerRef, test, periodEnd },
 *   intentId?, idempotencyKey, actor, sourceEventId, renewal? }
 */
async function pay(ctx, input) {
    const { db, rates } = ctx;
    const { subscriber, streamer } = input;
    if (subscriber === streamer) fail(422, 'billing.self_dealing', 'you cannot subscribe to yourself');
    return await money(db, async () => {
        const existingTxn = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existingTxn) return await result(db, await getTxn(db, existingTxn.id), ctx, true);
        if (input.intentId) intents.refuseIfSettledInLive(await intents.find(db, input.intentId));
        const r = input.receipt;
        if (r) {
            const dup = await db.prepare('SELECT id FROM transactions WHERE receipt_ref = ?').get(r.receiptRef);
            if (dup) return { ...await result(db, await getTxn(db, dup.id), ctx, true), duplicateReceipt: true };
        }
        const ms = ctx.now();
        const priceCents = input.priceCents != null ? positiveInt(input.priceCents, 'price_cents', 10_000_000) : rates.subPriceCents;
        const prior = await findPair(db, subscriber, streamer);

        let entries = [];
        let provider = 'credit';
        let meta;
        let route = null;
        if (input.source === 'credit') {
            const cost = rates.bitsForValueCents(priceCents);
            const share = Math.min(cost, rates.subShareBits(priceCents));
            await requireFunds(db, A.credit(subscriber), cost, 'credit');
            entries = [entry(A.credit(subscriber), -cost), entry(A.payable(streamer), share), entry(A.revenue('vibes-bits'), cost - share)];
            meta = { source: 'credit', price_cents: priceCents, cost_bits: cost, share_bits: share, sub_share_pct: rates.subSharePct };
        } else if (input.source === 'receipt' && r) {
            provider = r.provider;
            route = r.route || null;
            const paid = positiveInt(r.paidCents, 'amount_cents', MAX_RECEIPT_CENTS);
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
        const renewal = !!(prior && (prior.status === 'active' || prior.status === 'past_due' || input.renewal));

        const { txn } = await post(ctx, {
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
            await db.prepare(`UPDATE subscriptions SET provider = ?, provider_ref = COALESCE(?, provider_ref), route = ?, status = 'active', auto_renew = ?,
                    cancel_at_period_end = 0, price_cents = ?, current_period_end = ?, grace_until = NULL, renewal_failed_at = NULL, renewal_attempts = 0,
                    updated_at = ? WHERE id = ?`)
                .run(provider, r ? r.providerRef || null : null, route, autoRenew, priceCents, iso(end), nowIso, prior.id);
            sub = await find(db, prior.id);
        } else {
            const id = prefixedId('sub', ms);
            await db.prepare(`INSERT INTO subscriptions (id, subscriber, streamer, tier, provider, provider_ref, route, status, auto_renew, cancel_at_period_end,
                    price_cents, current_period_end, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 'active', ?, 0, ?, ?, ?, ?)`)
                .run(id, subscriber, streamer, provider, r ? r.providerRef || null : null, route, autoRenew, priceCents, iso(end), nowIso, nowIso);
            sub = await find(db, id);
        }
        await db.prepare(`INSERT INTO entitlements (id, subject, kind, scope, subscription_id, starts_at, ends_at, source_txn, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(prefixedId('ent', ms), subscriber, KIND, streamer, sub.id, iso(start), iso(end), txn.id, nowIso);
        if (input.intentId) await intents.markSettled(ctx, input.intentId, txn.id);

        if (txn.entries.length) await enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn) });
        await enqueue(ctx, {
            event_type: 'billing.entitlement.changed', subject: { type: 'entitlement', id: `${subscriber}:${KIND}:${streamer}` },
            payload: { ...await entitlement(db, subscriber, streamer, ms), reason: renewal ? 'renewed' : 'granted', transaction_id: txn.id },
        });
        return await result(db, txn, ctx, false);
    });
}

async function result(db, txn, ctx, replay) {
    const ent = await db.prepare('SELECT * FROM entitlements WHERE source_txn = ?').get(txn.id);
    const sub = ent ? await find(db, ent.subscription_id) : null;
    return { txn, subscription: sub, entitlement: sub ? await entitlement(db, sub.subscriber, sub.streamer, ctx.now()) : null, replay };
}

/**
 * Cancel at period end. Stripe subscriptions are cancelled AT STRIPE through the adapter first
 * (Live only flipped a local flag and Stripe kept billing); if Stripe refuses, nothing changes.
 */
async function cancel(ctx, { id, actor }, adapters) {
    const { db } = ctx;
    const sub = await find(db, id);
    if (!sub) fail(404, 'billing.subscription_not_found', `no subscription ${id}`);
    // past_due: cancelling stops the retries; the next sweep ends it.
    if (sub.status !== 'active' && sub.status !== 'past_due') return { subscription: sub, provider_sync: 'not_needed', replay: true };
    let providerSync = 'not_needed';
    if (sub.provider === 'stripe') {
        const stripe = adapters && adapters.stripe;
        if (!stripe || !stripe.enabled) fail(409, 'billing.provider_disabled', 'the Stripe adapter is disabled; cancelling here alone would leave Stripe billing the subscriber');
        if (!sub.provider_ref) fail(409, 'billing.provider_ref_missing', 'this Stripe subscription has no Stripe id to cancel');
        try { await stripe.cancelAtPeriodEnd(sub.provider_ref); }
        catch (e) { fail(502, 'billing.provider_error', `Stripe refused the cancellation: ${e.message}`); }
        providerSync = 'stripe_cancel_at_period_end';
    }
    await money(db, async () => {
        await db.prepare('UPDATE subscriptions SET cancel_at_period_end = 1, auto_renew = 0, updated_at = ? WHERE id = ?').run(iso(ctx.now()), id);
        await enqueue(ctx, {
            event_type: 'billing.subscription.canceled', subject: { type: 'subscription', id },
            payload: { subscription: present(await find(db, id)), provider_sync: providerSync, actor },
        });
    });
    return { subscription: await find(db, id), provider_sync: providerSync, replay: false };
}

/**
 * End (or reactivate) a subscription and say so. `extra` joins the event payload. With `periodEnd`, the change applies
 * only while the row still has that period end (a renewal paid meanwhile wins).
 */
async function setStatus(ctx, id, status, reason, { extra, periodEnd } = {}) {
    const { db } = ctx;
    const sub = await find(db, id);
    if (!sub || sub.status === status) return sub;
    const r = await db.prepare(`UPDATE subscriptions SET status = ?, auto_renew = CASE WHEN ? = 'active' THEN auto_renew ELSE 0 END, grace_until = NULL, updated_at = ?
        WHERE id = ? AND status = ?${periodEnd ? ' AND current_period_end = ?' : ''}`)
        .run(status, status, iso(ctx.now()), id, sub.status, ...(periodEnd ? [periodEnd] : []));
    if (!r.changes) return await find(db, id);
    await enqueue(ctx, {
        event_type: 'billing.entitlement.changed', subject: { type: 'entitlement', id: `${sub.subscriber}:${KIND}:${sub.streamer}` },
        payload: { ...await entitlement(db, sub.subscriber, sub.streamer, ctx.now()), reason: reason || status, ...(extra || {}) },
    });
    return await find(db, id);
}

/**
 * A renewal charge failed: past_due until `graceUntil` (kept from the first failure of the period). The event goes out
 * once, when the subscription turns past_due; a failed retry only counts the attempt. No-op if the row changed since
 * the sweep read it (a renewal paid, the subscription ended, or a concurrent sweep marked it first).
 */
async function markPastDue(ctx, sub, graceUntil) {
    const { db } = ctx;
    return await money(db, async () => {
        const at = iso(ctx.now());
        const r = await db.prepare(`UPDATE subscriptions SET status = 'past_due', grace_until = ?, renewal_failed_at = ?, renewal_attempts = renewal_attempts + 1, updated_at = ?
            WHERE id = ? AND status = ? AND current_period_end = ?`).run(graceUntil, at, at, sub.id, sub.status, sub.current_period_end);
        if (!r.changes || sub.status === 'past_due') return !!r.changes;
        await enqueue(ctx, {
            event_type: 'billing.entitlement.changed', subject: { type: 'entitlement', id: `${sub.subscriber}:${KIND}:${sub.streamer}` },
            payload: { ...await entitlement(db, sub.subscriber, sub.streamer, ctx.now()), reason: 'renewal_failed', grace_until: graceUntil, renewal_period_end: sub.current_period_end },
        });
        return true;
    });
}

/**
 * The renewal key of the period that ends at the subscription's current_period_end: renew:<sub>:<period end>, then
 * renew:<sub>:<period end>:<k> once k charges under the earlier keys were refunded or charged back (a reversal can
 * bring current_period_end back to an end already renewed once; replaying that key would "renew" with no charge and
 * no period). An unreversed charge under a key is that renewal: the key is returned and pay() replays it.
 */
async function renewalKey(db, sub) {
    const base = `renew:${sub.id}:${sub.current_period_end}`;
    for (let k = 0; ; k++) {
        const key = k ? `${base}:${k}` : base;
        const txn = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(key);
        if (!txn) return key;
        const reversed = await db.prepare("SELECT 1 AS x FROM transactions WHERE reverses_txn = ? AND type IN ('refund', 'chargeback') LIMIT 1").get(txn.id);
        if (!reversed) return key;
    }
}

/** Revoke the periods a reversed payment granted. Returns the number of periods revoked. */
async function revokeForTxn(ctx, txnId, reason) {
    const { db } = ctx;
    const ents = await db.prepare('SELECT * FROM entitlements WHERE source_txn = ? AND revoked_at IS NULL').all(txnId);
    if (!ents.length) return 0;
    const at = iso(ctx.now());
    for (const e of ents) {
        await db.prepare('UPDATE entitlements SET revoked_at = ?, revoked_reason = ? WHERE id = ?').run(at, reason, e.id);
        const sub = await find(db, e.subscription_id);
        if (sub) {
            const left = (await db.prepare('SELECT MAX(ends_at) AS e FROM entitlements WHERE subscription_id = ? AND revoked_at IS NULL').get(sub.id)).e;
            const stillActive = left && Date.parse(left) > ctx.now();
            await db.prepare('UPDATE subscriptions SET current_period_end = ?, status = ?, auto_renew = CASE WHEN ? THEN auto_renew ELSE 0 END, updated_at = ? WHERE id = ?')
                .run(left || at, stillActive ? sub.status : 'expired', stillActive ? 1 : 0, at, sub.id);
        }
        await enqueue(ctx, {
            event_type: 'billing.entitlement.changed', subject: { type: 'entitlement', id: `${e.subject}:${KIND}:${e.scope}` },
            payload: { ...await entitlement(db, e.subject, e.scope, ctx.now()), reason, revoked_period: { starts_at: e.starts_at, ends_at: e.ends_at } },
        });
    }
    return ents.length;
}

/**
 * Renewal sweep (hourly job). For every active or past_due subscription whose period ended:
 *   - Stripe: Stripe renews itself (invoice.paid); expire only after the grace window;
 *   - cancel-at-period-end / no auto-renew: end it;
 *   - past_due past grace_until: end it (grace_ended);
 *   - otherwise renew from the subscriber's credit (deterministic key per period, renewalKey), or,
 *     when the credit does not cover the price, past_due until the period end + the renewal grace
 *     (retried on the same key by every later sweep), or end it at once without a grace.
 * Canceled and expired subscriptions are never charged.
 */
async function sweep(ctx, { limit = 200 } = {}) {
    const { db, rates } = ctx;
    const out = { renewed: [], expired: [], canceled: [], past_due: [], skipped: 0 };
    const now = ctx.now();
    const graceMs = Math.max(0, Number(rates.renewalGraceDays) || 0) * 86_400_000;
    const due = (await db.prepare(`SELECT * FROM subscriptions WHERE status IN ('active', 'past_due') AND current_period_end IS NOT NULL AND current_period_end <= ?
        ORDER BY current_period_end LIMIT ?`).all(iso(now), limit)).map(parse);
    for (const sub of due) {
        const end = Date.parse(sub.current_period_end);
        if (sub.provider === 'stripe') {
            if (now - end < rates.stripeGraceDays * 86_400_000) { out.skipped++; continue; }
            await setStatus(ctx, sub.id, 'expired', 'stripe_not_renewed'); out.expired.push(sub.id); continue;
        }
        if (sub.cancel_at_period_end || !sub.auto_renew) {
            const st = sub.cancel_at_period_end ? 'canceled' : 'expired';
            await setStatus(ctx, sub.id, st, st); (st === 'canceled' ? out.canceled : out.expired).push(sub.id); continue;
        }
        const ended = { periodEnd: sub.current_period_end, extra: { renewal_period_end: sub.current_period_end } };
        if (sub.status === 'past_due' && (!sub.grace_until || now >= Date.parse(sub.grace_until))) {
            await setStatus(ctx, sub.id, 'expired', 'grace_ended', ended); out.expired.push(sub.id); continue;
        }
        try {
            const paid = await pay(ctx, {
                subscriber: sub.subscriber, streamer: sub.streamer, source: 'credit', priceCents: sub.price_cents || rates.subPriceCents,
                autoRenew: true, renewal: true, idempotencyKey: await renewalKey(db, sub),
                actor: { principal: 'svc:billing', job: 'renewal-sweep' },
            });
            // A replay means a concurrent sweep already renewed this period: it reports it, this one skips it.
            if (paid.replay) out.skipped++; else out.renewed.push(sub.id);
        } catch (e) {
            if (e.code !== 'billing.insufficient_funds') throw e;
            const graceUntil = sub.grace_until || iso(end + graceMs);
            if (graceMs > 0 && now < Date.parse(graceUntil)) {
                if (await markPastDue(ctx, sub, graceUntil)) out.past_due.push(sub.id);
                continue;
            }
            await setStatus(ctx, sub.id, 'expired', sub.status === 'past_due' ? 'grace_ended' : 'renewal_insufficient_credit', ended); out.expired.push(sub.id);
        }
    }
    return out;
}

async function list(db, { subscriber, streamer, status } = {}) {
    const where = [];
    const args = [];
    if (subscriber) { where.push('subscriber = ?'); args.push(subscriber); }
    if (streamer) { where.push('streamer = ?'); args.push(streamer); }
    if (status) { where.push('status = ?'); args.push(status); }
    return (await db.prepare(`SELECT * FROM subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`).all(...args)).map(parse);
}

module.exports = { pay, cancel, sweep, renewalKey, entitlement, activeEntitlements, revokeForTxn, setStatus, find, findPair, findByProviderRef, list, present, KIND };
