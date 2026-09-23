'use strict';

/**
 * Stripe adapter (DISABLED unless STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set; card rails
 * are off in production). Ported from Live server/monetization/payments.js, with what Live lacked:
 *
 *   checkout.session.completed  mode=payment → purchase settle (receipt stripe:<payment_intent>);
 *                               mode=subscription → links the Stripe subscription to the intent
 *   invoice.paid                every paid period (first and renewals) settles a subscription
 *                               payment and credits the creator's share (Live only moved the date)
 *   charge.refunded             refund of the purchase/invoice (cumulative amount_refunded)
 *   charge.dispute.funds_withdrawn  chargeback
 *   customer.subscription.deleted   subscription ended at Stripe
 *   cancelAtPeriodEnd()         POST /subscriptions/:id cancel_at_period_end=true (Live never told Stripe)
 */
const crypto = require('crypto');
const intents = require('../ops/intents');
const subscriptions = require('../ops/subscriptions');

function createStripe(cfg, { fetchImpl = globalThis.fetch } = {}) {
    const enabled = !!(cfg.secretKey && cfg.webhookSecret);

    async function api(method, path, params) {
        const res = await fetchImpl(`${cfg.apiBase}${path}`, {
            method,
            headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params ? params.toString() : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${(json.error && json.error.message) || 'error'}`);
        return json;
    }

    function verify(req) {
        const header = String(req.headers['stripe-signature'] || '');
        if (!cfg.webhookSecret || !header) return { ok: false, reason: 'missing signature' };
        const parts = header.split(',').map((kv) => kv.split('='));
        const t = (parts.find(([k]) => k === 't') || [])[1];
        const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
        if (!t || !sigs.length) return { ok: false, reason: 'malformed signature header' };
        if (Math.abs(Date.now() / 1000 - Number(t)) > cfg.toleranceSec) return { ok: false, reason: 'timestamp outside tolerance' };
        const expected = Buffer.from(crypto.createHmac('sha256', cfg.webhookSecret).update(`${t}.`).update(req.rawBody).digest('hex'));
        const ok = sigs.some((s) => { const b = Buffer.from(s); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
        return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
    }

    function parse(req) {
        const event = JSON.parse(req.rawBody.toString('utf8'));
        return { eventId: event.id ? String(event.id) : null, type: String(event.type || 'unknown'), payload: event };
    }

    function intentFrom(db, meta) {
        if (!meta) return null;
        return intents.find(db, meta.intent_id || meta.order_id);
    }

    async function interpret(ctx, event, row) {
        const obj = (event.data && event.data.object) || {};
        const key = `pe:stripe:${row.provider_event_id}`;
        const actor = { principal: 'provider:stripe', provider_event: row.provider_event_id };
        switch (event.type) {
            case 'checkout.session.completed': {
                const intent = intentFrom(ctx.db, obj.metadata) || intents.find(ctx.db, obj.client_reference_id);
                if (!intent) return { effect: 'none', reason: 'checkout without a Billing intent' };
                if (obj.mode === 'subscription') {
                    return { effect: 'update', reason: 'linked Stripe subscription', apply: (c) => intents.mergeMetadata(c, intent.id, { stripe_subscription: obj.subscription }) };
                }
                if (obj.payment_status && obj.payment_status !== 'paid') return { effect: 'none', reason: `checkout ${obj.payment_status}` };
                return { effect: 'purchase', args: { provider: 'stripe', receiptRef: `stripe:${obj.payment_intent || obj.id}`, intentId: intent.id, paidCents: obj.amount_total, idempotencyKey: key, actor } };
            }
            case 'invoice.paid':
            case 'invoice.payment_succeeded': {
                if (!(obj.amount_paid > 0)) return { effect: 'none', reason: 'zero-amount invoice' };
                const stripeSub = obj.subscription;
                const existing = subscriptions.findByProviderRef(ctx.db, 'stripe', stripeSub);
                let subscriber; let streamer; let intentId = null;
                if (existing) { subscriber = existing.subscriber; streamer = existing.streamer; }
                else {
                    const meta = (obj.subscription_details && obj.subscription_details.metadata) || obj.metadata || {};
                    let intent = intentFrom(ctx.db, meta);
                    if (!intent && stripeSub) intent = intents.parse(ctx.db.prepare("SELECT * FROM payment_intents WHERE provider = 'stripe' AND json_extract(metadata, '$.stripe_subscription') = ?").get(stripeSub));
                    if (!intent) return { effect: 'none', reason: `invoice for unknown Stripe subscription ${stripeSub}` };
                    subscriber = intent.subject; streamer = intent.streamer_subject; intentId = intent.id;
                }
                const line = obj.lines && obj.lines.data && obj.lines.data[0];
                const periodEnd = line && line.period && line.period.end ? new Date(line.period.end * 1000).toISOString() : null;
                return {
                    effect: 'subscription',
                    args: {
                        subscriber, streamer, source: 'receipt', intentId, autoRenew: true,
                        receipt: { provider: 'stripe', receiptRef: `stripe:${obj.id}`, paidCents: obj.amount_paid, feeCents: 0, providerRef: stripeSub, periodEnd },
                        idempotencyKey: key, actor,
                    },
                };
            }
            case 'charge.refunded':
                return {
                    effect: 'reverse',
                    args: {
                        kind: 'refund', provider: 'stripe', originalReceiptRef: `stripe:${obj.invoice || obj.payment_intent}`,
                        reversalRef: `stripe:refund:${obj.id}:${obj.amount_refunded}`, cumulativeCents: obj.amount_refunded,
                        idempotencyKey: key, actor, reason: 'charge.refunded',
                    },
                };
            case 'charge.dispute.funds_withdrawn':
                return {
                    effect: 'reverse',
                    args: {
                        kind: 'chargeback', provider: 'stripe', originalReceiptRef: `stripe:${obj.payment_intent}`,
                        reversalRef: `stripe:dispute:${obj.id}`, cents: obj.amount, idempotencyKey: key, actor, reason: obj.reason || 'dispute',
                    },
                };
            case 'customer.subscription.deleted': {
                const sub = subscriptions.findByProviderRef(ctx.db, 'stripe', obj.id);
                if (!sub) return { effect: 'none', reason: 'unknown Stripe subscription' };
                return { effect: 'update', reason: 'Stripe subscription ended', apply: (c) => subscriptions.setStatus(c, sub.id, 'canceled', 'stripe_deleted') };
            }
            default:
                return { effect: 'none', reason: `${event.type} is not handled` };
        }
    }

    async function createCheckout(ctx, intent, { successUrl, cancelUrl, name }) {
        const p = new URLSearchParams();
        p.set('success_url', successUrl);
        p.set('cancel_url', cancelUrl);
        p.set('client_reference_id', intent.id);
        p.set('metadata[intent_id]', intent.id);
        p.set('line_items[0][quantity]', '1');
        p.set('line_items[0][price_data][currency]', 'usd');
        p.set('line_items[0][price_data][unit_amount]', String(intent.amount_cents));
        p.set('line_items[0][price_data][product_data][name]', name);
        if (intent.kind === 'subscription') {
            p.set('mode', 'subscription');
            p.set('line_items[0][price_data][recurring][interval]', 'month');
            p.set('subscription_data[metadata][intent_id]', intent.id);
        } else {
            p.set('mode', 'payment');
        }
        const session = await api('POST', '/checkout/sessions', p);
        return { url: session.url, providerRef: session.id };
    }

    async function cancelAtPeriodEnd(stripeSubscriptionId) {
        const p = new URLSearchParams({ cancel_at_period_end: 'true' });
        return api('POST', `/subscriptions/${encodeURIComponent(stripeSubscriptionId)}`, p);
    }

    return { name: 'stripe', enabled, verify, parse, interpret, createCheckout, cancelAtPeriodEnd };
}

module.exports = { createStripe };
