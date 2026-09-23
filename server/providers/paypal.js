'use strict';

/**
 * PayPal adapter (DISABLED unless PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID are
 * set). Ported from Live server/monetization/payments.js.
 *
 *   verify                  PayPal's verify-webhook-signature API (as Live)
 *   PAYMENT.CAPTURE.COMPLETED  purchase or one-period subscription (custom_id = intent id), receipt paypal:<capture id>
 *   PAYMENT.CAPTURE.REFUNDED   refund of the capture (the refund's "up" link names the capture)
 *   PAYMENT.CAPTURE.REVERSED   chargeback/reversal of the capture
 *   capture()               captures an approved order after the buyer returns (Live's /paypal/return);
 *                           settlement still comes from the webhook, or from the capture response,
 *                           and the receipt reference makes either one settle exactly once.
 */
const intents = require('../ops/intents');

const cents = (v) => Math.round(Number(v) * 100);

function createPaypal(cfg, { fetchImpl = globalThis.fetch } = {}) {
    const enabled = !!(cfg.clientId && cfg.clientSecret && cfg.webhookId);

    async function json(url, opts) {
        const res = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(15000) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${body.message || body.error_description || body.error || 'error'}`);
        return body;
    }
    async function token() {
        const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
        const j = await json(`${cfg.apiBase}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
        return j.access_token;
    }

    async function verify(req) {
        if (!enabled) return { ok: false, reason: 'disabled' };
        const h = req.headers;
        try {
            const j = await json(`${cfg.apiBase}/v1/notifications/verify-webhook-signature`, {
                method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
                    transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'],
                    webhook_id: cfg.webhookId, webhook_event: JSON.parse(req.rawBody.toString('utf8')),
                }),
            });
            return j.verification_status === 'SUCCESS' ? { ok: true } : { ok: false, reason: 'verification failed' };
        } catch (e) { return { ok: false, reason: e.message }; }
    }

    function parse(req) {
        const event = JSON.parse(req.rawBody.toString('utf8'));
        return { eventId: event.id ? String(event.id) : null, type: String(event.event_type || 'unknown'), payload: event };
    }

    function settlePlan(ctx, capture, key, actor) {
        const intent = intents.find(ctx.db, capture.custom_id || (capture.supplementary_data && capture.supplementary_data.related_ids && capture.supplementary_data.related_ids.order_id));
        if (!intent) return { effect: 'none', reason: 'capture without a Billing intent' };
        const paid = capture.amount && capture.amount.currency_code === 'USD' ? cents(capture.amount.value) : null;
        if (!paid) return { effect: 'none', reason: 'capture without a USD amount' };
        const receipt = { provider: 'paypal', receiptRef: `paypal:${capture.id}`, paidCents: paid };
        if (intent.kind === 'purchase') return { effect: 'purchase', args: { ...receipt, intentId: intent.id, idempotencyKey: key, actor } };
        if (paid + 1 < intent.amount_cents) return { effect: 'none', reason: 'underpaid subscription capture — review', review: true };
        return { effect: 'subscription', args: { subscriber: intent.subject, streamer: intent.streamer_subject, source: 'receipt', intentId: intent.id, receipt, idempotencyKey: key, actor } };
    }

    async function interpret(ctx, event, row) {
        const r = event.resource || {};
        const key = `pe:paypal:${row.provider_event_id}`;
        const actor = { principal: 'provider:paypal', provider_event: row.provider_event_id };
        if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') return settlePlan(ctx, r, key, actor);
        if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' || event.event_type === 'PAYMENT.CAPTURE.REVERSED') {
            const up = (r.links || []).find((l) => l.rel === 'up');
            const captureId = up ? String(up.href).split('/').filter(Boolean).pop() : r.capture_id;
            if (!captureId) return { effect: 'none', reason: 'refund without its capture' };
            return {
                effect: 'reverse',
                args: {
                    kind: event.event_type === 'PAYMENT.CAPTURE.REVERSED' ? 'chargeback' : 'refund', provider: 'paypal',
                    originalReceiptRef: `paypal:${captureId}`, reversalRef: `paypal:refund:${r.id}`,
                    cents: r.amount ? cents(r.amount.value) : undefined, idempotencyKey: key, actor, reason: event.event_type,
                },
            };
        }
        return { effect: 'none', reason: `${event.event_type} is not handled` };
    }

    async function createCheckout(ctx, intent, { successUrl, cancelUrl, name }) {
        const j = await json(`${cfg.apiBase}/v2/checkout/orders`, {
            method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                intent: 'CAPTURE',
                purchase_units: [{ custom_id: intent.id, description: String(name).slice(0, 127), amount: { currency_code: 'USD', value: (intent.amount_cents / 100).toFixed(2) } }],
                application_context: { brand_name: 'OpenVibe', user_action: 'PAY_NOW', return_url: successUrl, cancel_url: cancelUrl },
            }),
        });
        const approve = (j.links || []).find((l) => l.rel === 'approve');
        return { url: approve ? approve.href : null, providerRef: j.id };
    }

    /** Capture an approved order; returns a settlement plan built from the capture. */
    async function capture(ctx, intent) {
        const j = await json(`${cfg.apiBase}/v2/checkout/orders/${encodeURIComponent(intent.provider_ref)}/capture`, {
            method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: '{}',
        });
        const cap = j.purchase_units && j.purchase_units[0] && j.purchase_units[0].payments && j.purchase_units[0].payments.captures && j.purchase_units[0].payments.captures[0];
        if (j.status !== 'COMPLETED' || !cap) return { effect: 'none', reason: `order ${j.status}` };
        return settlePlan(ctx, { ...cap, custom_id: cap.custom_id || intent.id }, `paypal-capture:${cap.id}`, { principal: 'provider:paypal', capture: cap.id });
    }

    return { name: 'paypal', enabled, verify, parse, interpret, createCheckout, capture };
}

module.exports = { createPaypal };
