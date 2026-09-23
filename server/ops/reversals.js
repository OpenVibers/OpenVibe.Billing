'use strict';

/**
 * Refunds, reversals and chargebacks of provider receipts (ADR-012 rule 2). Each is a new
 * transaction with reverses_txn → the original; history is never edited.
 *
 *   purchase      the buyer's remaining credit is clawed back (up to the bits the reversed part
 *                 bought). Credit already given away stays with its recipient: the recipient's
 *                 payable is never touched; the unrecovered value is booked to chargeback_loss
 *                 and the transaction is flagged for review.
 *   subscription  paid periods granted by the payment are revoked; the creator's share stays
 *                 (flagged for review); the money goes back out against refunds / chargeback_loss.
 *   donation      (site-routed tip) the creator's payable stays; loss booked, flagged for review.
 *
 * Partial reversals are supported; the cumulative reversed amount never exceeds what was paid.
 */
const { post, getTxn, balance } = require('../ledger');
const { enqueue } = require('../outbox');
const { A, entry, fail } = require('./common');
const { summary } = require('./purchases');
const intents = require('./intents');

function reversedCents(db, txnId) {
    return db.prepare(`SELECT COALESCE(SUM(json_extract(metadata, '$.cents')), 0) AS n FROM transactions WHERE reverses_txn = ? AND type IN ('refund', 'chargeback')`).get(txnId).n;
}

/**
 * input: { kind: 'refund'|'chargeback', provider, originalReceiptRef, reversalRef, cents?, cumulativeCents?,
 *          idempotencyKey, sourceEventId, actor, reason }
 */
function reverseReceipt(ctx, input) {
    const { db, rates } = ctx;
    return db.transaction(() => {
        const existing = db.prepare('SELECT id FROM transactions WHERE idempotency_key = ? OR (receipt_ref IS NOT NULL AND receipt_ref = ?)').get(input.idempotencyKey, input.reversalRef || null);
        if (existing) return { txn: getTxn(db, existing.id), replay: true };
        const origRow = db.prepare('SELECT id FROM transactions WHERE receipt_ref = ?').get(input.originalReceiptRef);
        if (!origRow) fail(404, 'billing.original_not_found', `no settled receipt ${input.originalReceiptRef}`);
        const orig = getTxn(db, origRow.id);
        const paid = Number(orig.metadata.paid_cents) || 0;
        const done = reversedCents(db, orig.id);
        const remaining = paid - done;
        let cents = input.cumulativeCents != null ? Number(input.cumulativeCents) - done : (input.cents != null ? Number(input.cents) : remaining);
        cents = Math.min(Math.round(cents), remaining);
        if (!(cents > 0)) return { txn: null, replay: false, noop: 'already_reversed' };

        const kind = input.kind === 'chargeback' ? 'chargeback' : 'refund';
        const lossOrRefund = kind === 'chargeback' ? A.loss() : A.refunds();
        const entries = [];
        const meta = { cents, original_paid_cents: paid, reason: input.reason || null };
        let review = false;
        let revoked = 0;

        if (orig.type === 'purchase') {
            const B = Number(orig.metadata.bits) || 0;
            const b = Math.round((B * (done + cents)) / paid) - Math.round((B * done) / paid);
            const owner = orig.to_subject;
            const clawed = Math.max(0, Math.min(balance(db, A.credit(owner)), b));
            const unrecovered = b - clawed;
            const nonFx = cents - rates.valueCents(clawed);
            entries.push(entry(A.credit(owner), -clawed), entry(A.fxBits(), clawed), entry(A.fxCents(), -rates.valueCents(clawed)), entry(A.clearing(orig.provider), cents));
            if (kind === 'chargeback') {
                entries.push(entry(A.loss(), -nonFx));
            } else {
                const lossPart = Math.min(nonFx, rates.valueCents(unrecovered));
                entries.push(entry(A.loss(), -lossPart), entry(A.refunds(), -(nonFx - lossPart)));
            }
            Object.assign(meta, { bits_reversed: b, bits_clawed_back: clawed, unrecovered_bits: unrecovered });
            review = unrecovered > 0;
        } else if (orig.type === 'subscription' || orig.type === 'donation') {
            if (orig.entries.length) {
                entries.push(entry(A.clearing(orig.provider), cents), entry(lossOrRefund, -cents));
                review = true; // the creator's share/payable was kept
                meta.creator_payable_kept_bits = Number(orig.metadata.share_bits || orig.metadata.amount_bits) || 0;
            } else {
                meta.external = true; // the money never touched OpenVibe
            }
        } else {
            fail(422, 'billing.not_reversible', `${orig.type} transactions are not provider receipts`);
        }
        if (review) meta.review = 'required';

        const { txn } = post(ctx, {
            type: kind,
            idempotencyKey: input.idempotencyKey,
            reversesTxn: orig.id,
            entries,
            test: orig.test,
            actor: input.actor,
            fromSubject: orig.to_subject,
            toSubject: orig.from_subject,
            provider: orig.provider,
            receiptRef: input.reversalRef || null,
            sourceEventId: input.sourceEventId,
            metadata: { ...meta, rates: rates.snapshot() },
        });
        if (orig.type === 'subscription') revoked = require('./subscriptions').revokeForTxn(ctx, orig.id, kind);
        if (done + cents >= paid && orig.metadata.intent_id) intents.setStatus(ctx, orig.metadata.intent_id, 'refunded');
        enqueue(ctx, {
            event_type: 'billing.transaction.reversed', subject: { type: 'transaction', id: txn.id },
            payload: { ...summary(txn), reverses_txn: orig.id, review: review ? 'required' : null, entitlements_revoked: revoked },
        });
        return { txn, replay: false, review };
    })();
}

module.exports = { reverseReceipt, reversedCents };
