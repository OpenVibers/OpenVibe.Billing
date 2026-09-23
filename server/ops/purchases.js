'use strict';

/**
 * Purchases: a provider receipt becomes spendable credit (CREDIT, ADR-012).
 *
 *   settle(ctx, { provider, receiptRef, subject?, paidCents, bits?, intentId?, test, ... })
 *
 * The receipt reference is unique across the journal, so the same provider payment settles once
 * whatever event, retry or API call carries it. Bits credited:
 *   - the intent's package when the payment covers its price (one cent of slack, as Live);
 *   - an explicit `bits` when its value is covered by the payment;
 *   - otherwise what the payment buys under the price tiers (never the package on faith).
 */
const { post, getTxn, BillingError, present } = require('../ledger');
const { enqueue } = require('../outbox');
const { A, receiptEntries, fail, positiveInt } = require('./common');
const intents = require('./intents');

function settle(ctx, input) {
    const { db, rates } = ctx;
    return db.transaction(() => {
        const receiptRef = input.receiptRef;
        if (!receiptRef) fail(422, 'billing.invalid_input', 'a provider receipt reference is required');
        const dup = db.prepare('SELECT id FROM transactions WHERE receipt_ref = ?').get(receiptRef);
        if (dup) return { txn: getTxn(db, dup.id), replay: true, duplicateReceipt: true };

        const paidCents = positiveInt(input.paidCents, 'amount_cents', 100_000_000);
        let intent = null;
        if (input.intentId) {
            intent = intents.find(db, input.intentId);
            if (!intent) fail(404, 'billing.intent_not_found', `no payment intent ${input.intentId}`);
            if (intent.kind !== 'purchase') fail(422, 'billing.intent_mismatch', `intent ${intent.id} is a ${intent.kind}, not a purchase`);
            if (intent.provider !== input.provider) fail(422, 'billing.intent_mismatch', `intent ${intent.id} belongs to ${intent.provider}, not ${input.provider}`);
            if (input.subject && input.subject !== intent.subject) fail(422, 'billing.intent_mismatch', 'the intent belongs to another subject');
            if (intent.status === 'settled' && intent.settled_txn) return { txn: getTxn(db, intent.settled_txn), replay: true };
        }
        const subject = intent ? intent.subject : input.subject;
        if (!subject) fail(422, 'billing.invalid_subject', 'a purchase needs a subject or an intent');

        let bits;
        let basis;
        if (intent && intent.bits && paidCents >= intent.amount_cents - 1) {
            bits = intent.bits; basis = 'intent_package';
        } else if (input.bits != null) {
            bits = positiveInt(input.bits, 'bits', rates.maxBits); basis = 'explicit';
        } else {
            bits = rates.bitsForPriceCents(paidCents); basis = intent ? 'paid_amount_underpaid_intent' : 'paid_amount_tiers';
        }
        if (bits < 1) fail(422, 'billing.amount_too_small', `a payment of ${paidCents} cents buys no Vibes`);
        if (bits > rates.maxBits) fail(422, 'billing.invalid_amount', `bits exceed the maximum of ${rates.maxBits}`);

        const { txn } = post(ctx, {
            type: 'purchase',
            idempotencyKey: input.idempotencyKey,
            entries: receiptEntries(rates, { provider: input.provider, paidCents, bits, target: A.credit(subject) }),
            test: !!input.test,
            actor: input.actor,
            toSubject: subject,
            provider: input.provider,
            receiptRef,
            sourceEventId: input.sourceEventId,
            metadata: {
                paid_cents: paidCents, bits, value_cents: rates.valueCents(bits), revenue_cents: paidCents - rates.valueCents(bits),
                pricing: basis, intent_id: intent ? intent.id : null, rates: rates.snapshot(), ...(input.metadata || {}),
            },
        });
        if (intent) intents.markSettled(ctx, intent.id, txn.id);
        enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn), traceId: input.traceId });
        return { txn, replay: false };
    })();
}

function summary(txn) {
    const t = present(txn);
    return { transaction_id: t.id, type: t.type, test: t.test, from_subject: t.from_subject, to_subject: t.to_subject, provider: t.provider, metadata: t.metadata };
}

module.exports = { settle, summary, BillingError };
