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
 *
 * A subscription period paid from credit has no receipt: staff refund it whole (refundCreditPeriod).
 */
const { post, getTxn, balance, money } = require('../ledger');
const { enqueue } = require('../outbox');
const { A, entry, fail, text } = require('./common');
const { summary } = require('./purchases');
const intents = require('./intents');

async function reversedCents(db, txnId) {
    return (await db.prepare(`SELECT COALESCE(SUM(json_extract(metadata, '$.cents')::bigint), 0)::bigint AS n FROM transactions WHERE reverses_txn = ? AND type IN ('refund', 'chargeback')`).get(txnId)).n;
}

/**
 * input: { kind: 'refund'|'chargeback', provider, originalReceiptRef, reversalRef, cents?, cumulativeCents?,
 *          idempotencyKey, sourceEventId, actor, reason }
 */
async function reverseReceipt(ctx, input) {
    const { db, rates } = ctx;
    return await money(db, async () => {
        const existing = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ? OR (receipt_ref IS NOT NULL AND receipt_ref = ?)').get(input.idempotencyKey, input.reversalRef || null);
        if (existing) return { txn: await getTxn(db, existing.id), replay: true };
        const origRow = await db.prepare('SELECT id FROM transactions WHERE receipt_ref = ?').get(input.originalReceiptRef);
        if (!origRow) fail(404, 'billing.original_not_found', `no settled receipt ${input.originalReceiptRef}`);
        const orig = await getTxn(db, origRow.id);
        const paid = Number(orig.metadata.paid_cents) || 0;
        const done = await reversedCents(db, orig.id);
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
            const clawed = Math.max(0, Math.min(await balance(db, A.credit(owner)), b));
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

        const { txn } = await post(ctx, {
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
        if (orig.type === 'subscription') revoked = await require('./subscriptions').revokeForTxn(ctx, orig.id, kind);
        if (done + cents >= paid && orig.metadata.intent_id) await intents.setStatus(ctx, orig.metadata.intent_id, 'refunded');
        await enqueue(ctx, {
            event_type: 'billing.transaction.reversed', subject: { type: 'transaction', id: txn.id },
            payload: { ...summary(txn), reverses_txn: orig.id, review: review ? 'required' : null, entitlements_revoked: revoked },
        });
        return { txn, replay: false, review };
    });
}

/**
 * Refund one subscription period paid from credit (staff, POST /subscriptions/:id/refund), whole period only.
 * input: { subscriptionId, transactionId? | periodEnd?, reason, idempotencyKey, actor }
 *
 * The entries undo the payment: user_credit:<subscriber> +cost, platform_revenue −(cost − share), and the creator's
 * share comes back out of creator_payable:<streamer> as far as the payable still holds it; a share already cashed
 * out (or moved on) is booked to chargeback_loss through fx and the refund is flagged for review, as for purchases.
 * A credit period is paid from user_credit only, so a promo allowance is never refunded into credit or earnings.
 * The period is revoked (revokeForTxn shortens or ends the subscription). Idempotent on the key; a period already
 * refunded or charged back is a no-op whatever the key, so a second call never refunds twice.
 */
async function refundCreditPeriod(ctx, input) {
    const { db, rates } = ctx;
    const reason = text(input.reason, 'reason', 300);
    if (!reason) fail(422, 'billing.invalid_input', 'a refund needs a reason');
    return await money(db, async () => {
        const existing = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing) return { txn: await getTxn(db, existing.id), replay: true };
        const sub = await db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(input.subscriptionId);
        if (!sub) fail(404, 'billing.subscription_not_found', `no subscription ${input.subscriptionId}`);
        let txnId = input.transactionId || null;
        if (!txnId) {
            const end = Date.parse(input.periodEnd);
            if (!Number.isFinite(end)) fail(422, 'billing.invalid_input', 'name the period: transaction_id (the payment) or period_end');
            const ent = (await db.prepare('SELECT source_txn, ends_at FROM entitlements WHERE subscription_id = ? ORDER BY ends_at DESC').all(sub.id))
                .find((e) => Date.parse(e.ends_at) === end);
            if (!ent || !ent.source_txn) fail(404, 'billing.period_not_found', `${sub.id} has no paid period ending ${input.periodEnd}`);
            txnId = ent.source_txn;
        }
        const orig = await getTxn(db, txnId);
        const granted = orig && await db.prepare('SELECT 1 AS x FROM entitlements WHERE source_txn = ? AND subscription_id = ? LIMIT 1').get(orig.id, sub.id);
        if (!orig || orig.type !== 'subscription' || !granted) fail(404, 'billing.period_not_found', `${txnId} did not pay a period of ${sub.id}`);
        if (orig.metadata.source !== 'credit') fail(422, 'billing.not_refundable', 'only periods paid from credit are refunded here; a provider receipt is reversed by its provider event');
        const prior = await db.prepare("SELECT id FROM transactions WHERE reverses_txn = ? AND type IN ('refund', 'chargeback') ORDER BY created_at LIMIT 1").get(orig.id);
        if (prior) return { txn: null, replay: false, noop: 'already_reversed', reversedBy: prior.id };

        const subscriber = orig.from_subject;
        const streamer = orig.to_subject;
        const cost = Number(orig.metadata.cost_bits) || 0;
        const share = Number(orig.metadata.share_bits) || 0;
        const clawed = Math.max(0, Math.min(await balance(db, A.payable(streamer)), share));
        const unrecovered = share - clawed;
        const lossCents = rates.valueCents(unrecovered);
        const entries = [
            entry(A.credit(subscriber), cost), entry(A.revenue('vibes-bits'), -(cost - share)), entry(A.payable(streamer), -clawed),
            entry(A.fxBits(), -unrecovered), entry(A.fxCents(), lossCents), entry(A.loss(), -lossCents),
        ];
        const review = unrecovered > 0;
        const { txn } = await post(ctx, {
            type: 'refund',
            idempotencyKey: input.idempotencyKey,
            reversesTxn: orig.id,
            entries,
            test: orig.test,
            actor: input.actor,
            fromSubject: streamer,
            toSubject: subscriber,
            metadata: {
                source: 'credit', reason, subscription_id: sub.id, period_start: orig.metadata.period_start || null, period_end: orig.metadata.period_end || null,
                bits_refunded: cost, share_bits: share, share_clawed_back_bits: clawed, unrecovered_share_bits: unrecovered, loss_cents: lossCents,
                ...(review ? { review: 'required' } : {}), rates: rates.snapshot(),
            },
        });
        const revoked = await require('./subscriptions').revokeForTxn(ctx, orig.id, 'refund');
        if (orig.metadata.intent_id) await intents.setStatus(ctx, orig.metadata.intent_id, 'refunded');
        await enqueue(ctx, {
            event_type: 'billing.transaction.reversed', subject: { type: 'transaction', id: txn.id },
            payload: { ...summary(txn), reverses_txn: orig.id, review: review ? 'required' : null, entitlements_revoked: revoked },
        });
        return { txn, replay: false, review };
    });
}

module.exports = { reverseReceipt, reversedCents, refundCreditPeriod };
