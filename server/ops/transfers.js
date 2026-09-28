'use strict';

/**
 * Transfers: the only way CREDIT becomes MONEY (ADR-012 rule 3) — a tip, donation or paid
 * interaction moves the giver's spendable credit into the recipient's creator payable.
 *
 *   create()          user_credit:<from>  → creator_payable:<to>   (self-dealing refused by subject)
 *   refund()          creator_payable:<to> → user_credit:<from>    (e.g. a media request that never
 *                     played; refused when the recipient no longer holds the amount)
 *   fromReceipt()     a site-routed PowerChat tip: money received for a creator, straight into
 *                     their payable (MONEY); the tipper may be unknown.
 */
const { validate } = require('openvibe-contracts');
const { post, getTxn, requireFunds, money } = require('../ledger');
const { enqueue } = require('../outbox');
const { A, MAX_RECEIPT_CENTS, entry, receiptEntries, fail, positiveInt, text } = require('./common');
const { summary } = require('./purchases');

const KINDS = ['tip', 'donation', 'paid_interaction'];

async function create(ctx, input) {
    const { db, rates } = ctx;
    const amount = positiveInt(input.amount, 'amount', rates.maxBits);
    const from = input.from;
    const to = input.to;
    if (from === to) fail(422, 'billing.self_dealing', 'a transfer to yourself would turn bought credit into withdrawable money');
    const kind = input.kind || 'donation';
    if (!KINDS.includes(kind)) fail(422, 'billing.invalid_input', `kind must be one of ${KINDS.join(', ')}`);
    let target = null;
    if (input.target != null) {
        const v = validate('common.entity-ref@1', input.target);
        if (!v.valid) fail(422, 'billing.invalid_input', 'target must be an EntityRef ({ service, type, id })');
        target = input.target;
    }
    const message = text(input.message, 'message', 500);
    return await money(db, async () => {
        const existing = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing) return { txn: await getTxn(db, existing.id), replay: true };
        await requireFunds(db, A.credit(from), amount, 'credit');
        const { txn } = await post(ctx, {
            type: 'donation',
            idempotencyKey: input.idempotencyKey,
            entries: [entry(A.credit(from), -amount), entry(A.payable(to), amount)],
            actor: input.actor,
            fromSubject: from,
            toSubject: to,
            metadata: { kind, amount_bits: amount, target, message, rates: rates.snapshot() },
        });
        await enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn), traceId: input.traceId });
        return { txn, replay: false };
    });
}

async function refund(ctx, input) {
    const { db } = ctx;
    return await money(db, async () => {
        const existing = await db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing) return { txn: await getTxn(db, existing.id), replay: true };
        const orig = await getTxn(db, input.txnId);
        if (!orig || orig.type !== 'donation') fail(404, 'billing.transaction_not_found', `no donation ${input.txnId}`);
        if (!orig.from_subject || orig.receipt_ref) fail(422, 'billing.not_refundable', 'only credit-funded transfers are refunded this way; provider receipts are reversed by their provider events');
        const done = (await db.prepare(`SELECT COALESCE(SUM(json_extract(metadata, '$.amount_bits')::bigint), 0)::bigint AS n FROM transactions WHERE reverses_txn = ? AND type = 'refund'`).get(orig.id)).n;
        const remaining = orig.metadata.amount_bits - done;
        const amount = input.amount != null ? positiveInt(input.amount, 'amount') : remaining;
        if (amount > remaining) fail(409, 'billing.already_reversed', `only ${remaining} bits of ${orig.id} remain refundable`);
        await requireFunds(db, A.payable(orig.to_subject), amount, "recipient's payable");
        const { txn } = await post(ctx, {
            type: 'refund',
            idempotencyKey: input.idempotencyKey,
            reversesTxn: orig.id,
            entries: [entry(A.payable(orig.to_subject), -amount), entry(A.credit(orig.from_subject), amount)],
            actor: input.actor,
            fromSubject: orig.to_subject,
            toSubject: orig.from_subject,
            test: orig.test,
            metadata: { amount_bits: amount, reason: text(input.reason, 'reason', 300) },
        });
        await enqueue(ctx, { event_type: 'billing.transaction.reversed', subject: { type: 'transaction', id: txn.id }, payload: { ...summary(txn), reverses_txn: orig.id } });
        return { txn, replay: false };
    });
}

async function fromReceipt(ctx, input) {
    const { db, rates } = ctx;
    return await money(db, async () => {
        const dup = await db.prepare('SELECT id FROM transactions WHERE receipt_ref = ?').get(input.receiptRef);
        if (dup) return { txn: await getTxn(db, dup.id), replay: true, duplicateReceipt: true };
        const paidCents = positiveInt(input.paidCents, 'amount_cents', MAX_RECEIPT_CENTS);
        if (input.from && input.from === input.to) fail(422, 'billing.self_dealing', 'a creator cannot route a tip to themselves');
        const bits = rates.bitsForValueCents(paidCents);
        const { txn } = await post(ctx, {
            type: 'donation',
            idempotencyKey: input.idempotencyKey,
            entries: receiptEntries(rates, { provider: input.provider, paidCents, bits, target: A.payable(input.to) }),
            test: !!input.test,
            actor: input.actor,
            fromSubject: input.from || null,
            toSubject: input.to,
            provider: input.provider,
            receiptRef: input.receiptRef,
            sourceEventId: input.sourceEventId,
            metadata: { kind: 'tip', route: 'site', paid_cents: paidCents, amount_bits: bits, rates: rates.snapshot(), ...(input.metadata || {}) },
        });
        await enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn) });
        return { txn, replay: false };
    });
}

module.exports = { create, refund, fromReceipt };
