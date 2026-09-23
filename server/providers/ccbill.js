'use strict';

/**
 * CCBill adapter (DISABLED unless CCBILL_WEBHOOK_SECRET is set). Ported from Live
 * server/monetization/payments.js: FlexForms hosted payment + webhook authenticated by a shared
 * secret in the query string (compared in constant time here).
 *
 *   NewSaleSuccess   purchase or one-period subscription (X-intent / X-order passthrough), receipt
 *                    ccbill:<transactionId>. The price CCBill reports is required: the intent id rides
 *                    in the buyer-editable form URL, the form digest covers only the price.
 *   Refund, Void     refund of the sale;  Chargeback  chargeback of the sale.
 */
const crypto = require('crypto');
const intents = require('../ops/intents');

function createCcbill(cfg) {
    const enabled = !!cfg.webhookSecret;

    function verify(req) {
        const given = Buffer.from(String(req.query.secret || ''));
        const expected = Buffer.from(cfg.webhookSecret || '');
        if (!expected.length) return { ok: false, reason: 'disabled' };
        return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? { ok: true } : { ok: false, reason: 'bad secret' };
    }

    function parse(req) {
        const raw = req.rawBody.toString('utf8');
        let body = {};
        if (raw.trim().startsWith('{')) { try { body = JSON.parse(raw); } catch { body = {}; } }
        else body = Object.fromEntries(new URLSearchParams(raw));
        const { secret, ...query } = req.query; // never store the secret
        const p = { ...query, ...body };
        const type = String(p.eventType || p.transactionType || 'unknown');
        const txId = p.transactionId || p.subscriptionId;
        const eventId = txId ? `${type}:${txId}` : crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
        return { eventId, type, payload: p };
    }

    async function interpret(ctx, p, row) {
        const key = `pe:ccbill:${row.provider_event_id}`;
        const actor = { principal: 'provider:ccbill', provider_event: row.provider_event_id };
        const type = String(p.eventType || p.transactionType || '');
        const txId = p.transactionId || p.subscriptionId;
        const price = [p.billedInitialPrice, p.subscriptionInitialPrice, p.accountingInitialPrice, p.initialPrice, p.accountingAmount, p.amount]
            .find((v) => v != null && v !== '' && Number.isFinite(Number(v)));
        if (/^(Refund|Void|Chargeback)$/i.test(type)) {
            if (!txId) return { effect: 'none', reason: `${type} without a transaction id` };
            return {
                effect: 'reverse',
                args: {
                    kind: /chargeback/i.test(type) ? 'chargeback' : 'refund', provider: 'ccbill', originalReceiptRef: `ccbill:${txId}`,
                    reversalRef: `ccbill:${type.toLowerCase()}:${txId}`, cents: price != null ? Math.round(Number(price) * 100) : undefined,
                    idempotencyKey: key, actor, reason: type,
                },
            };
        }
        if (type !== 'NewSaleSuccess') return { effect: 'none', reason: `${type || 'event'} is not handled` };
        const intent = intents.find(ctx.db, p['X-intent'] || p['X-order'] || p.order);
        if (!intent) return { effect: 'none', reason: 'sale without a Billing intent' };
        if (price == null) return { effect: 'none', reason: 'sale carried no price — not credited', review: true };
        if (!txId) return { effect: 'none', reason: 'sale without a transaction id', review: true };
        const receipt = { provider: 'ccbill', receiptRef: `ccbill:${txId}`, paidCents: Math.round(Number(price) * 100) };
        if (intent.kind === 'purchase') return { effect: 'purchase', args: { ...receipt, intentId: intent.id, idempotencyKey: key, actor } };
        if (receipt.paidCents + 1 < intent.amount_cents) return { effect: 'none', reason: 'underpaid subscription sale — review', review: true };
        return { effect: 'subscription', args: { subscriber: intent.subject, streamer: intent.streamer_subject, source: 'receipt', intentId: intent.id, receipt, idempotencyKey: key, actor } };
    }

    async function createCheckout(ctx, intent) {
        const price = (intent.amount_cents / 100).toFixed(2);
        const period = '2';
        const currency = '840';
        const digest = crypto.createHash('md5').update(`${price}${period}${currency}${cfg.salt}`).digest('hex');
        const qs = new URLSearchParams({
            clientAccnum: cfg.clientAccount, clientSubacc: cfg.subAccount, initialPrice: price, initialPeriod: period,
            currencyCode: currency, formDigest: digest, 'X-intent': intent.id,
        });
        return { url: `https://api.ccbill.com/wap-frontflex/flexforms/${cfg.flexformId}?${qs}`, providerRef: null };
    }

    return { name: 'ccbill', enabled, verify, parse, interpret, createCheckout };
}

module.exports = { createCcbill };
