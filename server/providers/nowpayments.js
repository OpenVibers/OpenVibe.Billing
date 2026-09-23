'use strict';

/**
 * NOWPayments (crypto) adapter (DISABLED unless NOWPAYMENTS_IPN_SECRET is set). Ported from Live
 * server/monetization/payments.js: IPN verified by HMAC-SHA512 of the key-sorted JSON body
 * (X-NOWPayments-Sig).
 *
 *   payment_status finished | confirmed | sending   settle (order_id = intent id), receipt nowpayments:<payment_id>
 *   payment_status refunded                          refund of that payment
 * A payment reports several statuses; the receipt reference settles it exactly once.
 */
const crypto = require('crypto');
const intents = require('../ops/intents');

function sortObject(o) {
    if (Array.isArray(o)) return o.map(sortObject);
    if (o && typeof o === 'object') return Object.keys(o).sort().reduce((acc, k) => { acc[k] = sortObject(o[k]); return acc; }, {});
    return o;
}

function createNowpayments(cfg, { fetchImpl = globalThis.fetch } = {}) {
    const enabled = !!cfg.ipnSecret;

    function verify(req) {
        const sig = String(req.headers['x-nowpayments-sig'] || '');
        if (!cfg.ipnSecret || !sig) return { ok: false, reason: 'missing signature' };
        let obj;
        try { obj = JSON.parse(req.rawBody.toString('utf8')); } catch { return { ok: false, reason: 'not JSON' }; }
        const expected = Buffer.from(crypto.createHmac('sha512', cfg.ipnSecret).update(JSON.stringify(sortObject(obj))).digest('hex'));
        const given = Buffer.from(sig);
        return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
    }

    function parse(req) {
        const body = JSON.parse(req.rawBody.toString('utf8'));
        const status = String(body.payment_status || 'unknown');
        return { eventId: body.payment_id != null ? `${body.payment_id}:${status}` : null, type: status, payload: body };
    }

    async function interpret(ctx, b, row) {
        const key = `pe:nowpayments:${row.provider_event_id}`;
        const actor = { principal: 'provider:nowpayments', provider_event: row.provider_event_id };
        const status = String(b.payment_status);
        if (status === 'refunded') {
            return { effect: 'reverse', args: { kind: 'refund', provider: 'nowpayments', originalReceiptRef: `nowpayments:${b.payment_id}`, reversalRef: `nowpayments:refund:${b.payment_id}`, idempotencyKey: key, actor, reason: 'refunded' } };
        }
        if (!['finished', 'confirmed', 'sending'].includes(status)) return { effect: 'none', reason: `payment ${status}` };
        const intent = intents.find(ctx.db, b.order_id);
        if (!intent) return { effect: 'none', reason: 'payment without a Billing intent' };
        if (String(b.price_currency || 'usd').toLowerCase() !== 'usd' || b.price_amount == null) return { effect: 'none', reason: 'payment without a USD price', review: true };
        const receipt = { provider: 'nowpayments', receiptRef: `nowpayments:${b.payment_id}`, paidCents: Math.round(Number(b.price_amount) * 100) };
        if (intent.kind === 'purchase') return { effect: 'purchase', args: { ...receipt, intentId: intent.id, idempotencyKey: key, actor } };
        if (receipt.paidCents + 1 < intent.amount_cents) return { effect: 'none', reason: 'underpaid subscription — review', review: true };
        return { effect: 'subscription', args: { subscriber: intent.subject, streamer: intent.streamer_subject, source: 'receipt', intentId: intent.id, receipt, idempotencyKey: key, actor } };
    }

    async function createCheckout(ctx, intent, { successUrl, cancelUrl, name, ipnUrl }) {
        const res = await fetchImpl(`${cfg.apiBase}/invoice`, {
            method: 'POST', headers: { 'x-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                price_amount: intent.amount_cents / 100, price_currency: 'usd', order_id: intent.id, order_description: name,
                ipn_callback_url: ipnUrl, success_url: successUrl, cancel_url: cancelUrl,
            }),
            signal: AbortSignal.timeout(15000),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`NOWPayments invoice → ${res.status}`);
        return { url: j.invoice_url, providerRef: String(j.id || j.invoice_id || '') || null };
    }

    return { name: 'nowpayments', enabled, verify, parse, interpret, createCheckout };
}

module.exports = { createNowpayments, sortObject };
