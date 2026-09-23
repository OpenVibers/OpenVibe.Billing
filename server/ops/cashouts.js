'use strict';

/**
 * Cashouts (MONEY leaving the platform) and recycling (MONEY → CREDIT, ADR-012 rule 4).
 *
 *   request()  creator_payable → payouts_pending; escrow_until = now + escrowDays
 *   approve()  payouts_pending → out through the payout provider; needs a payout reference from
 *              the provider and is refused while the escrow period runs (rule 10)
 *   deny()     reverses the request: payouts_pending → creator_payable
 *   recycle()  creator_payable → user_credit, an explicit journal entry
 */
const { post, getTxn, requireFunds, iso, prefixedId } = require('../ledger');
const { enqueue } = require('../outbox');
const { A, entry, fail, positiveInt, text } = require('./common');
const { summary } = require('./purchases');

function parse(row) {
    return row ? { ...row, payout_method: JSON.parse(row.payout_method || '{}'), decided_by: row.decided_by ? JSON.parse(row.decided_by) : null } : null;
}
function find(db, id) { return parse(db.prepare('SELECT * FROM cashouts WHERE id = ?').get(id)); }

function present(c) {
    if (!c) return null;
    return {
        id: c.id, subject: { type: 'user', id: c.subject }, amount_bits: c.amount_bits, value_cents: c.value_cents,
        status: c.status, payout_method: c.payout_method, escrow_until: c.escrow_until,
        request_txn: c.request_txn, settle_txn: c.settle_txn || null,
        payout_provider: c.payout_provider || null, payout_reference: c.payout_reference || null,
        reason: c.reason || null, created_at: c.created_at, updated_at: c.updated_at,
    };
}

/**
 * The cashout as an event carries it: the payout method's TYPE only. The address (e.g. a PayPal
 * email) stays in Billing, where the staff console reads it; the event stream is retained and
 * read by other services, so it never gets the creator's contact details.
 */
function eventView(c) {
    const v = present(c);
    if (v) v.payout_method = { type: (c.payout_method && c.payout_method.type) || null };
    return v;
}

function payoutMethod(v) {
    if (!v || typeof v !== 'object') fail(422, 'billing.invalid_input', "payout_method is required, e.g. { type: 'paypal', address: 'name@example.com' }");
    const type = String(v.type || '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(type)) fail(422, 'billing.invalid_input', 'payout_method.type is required');
    const address = text(v.address, 'payout_method.address', 254);
    if (!address) fail(422, 'billing.invalid_input', 'payout_method.address is required');
    if (type === 'paypal' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) fail(422, 'billing.invalid_input', 'payout_method.address must be a PayPal email');
    return { type, address };
}

function request(ctx, input) {
    const { db, rates } = ctx;
    const amount = positiveInt(input.amount, 'amount', rates.maxBits);
    if (amount < rates.minCashoutBits) fail(422, 'billing.amount_too_small', `the minimum cashout is ${rates.minCashoutBits} bits`);
    const method = payoutMethod(input.payout_method);
    return db.transaction(() => {
        const existing = db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing) return { cashout: parse(db.prepare('SELECT * FROM cashouts WHERE request_txn = ?').get(existing.id)), replay: true };
        requireFunds(db, A.payable(input.subject), amount, 'creator payable (only money given to you can be cashed out)');
        const ms = ctx.now();
        const id = prefixedId('co', ms);
        const escrowUntil = iso(ms + rates.escrowDays * 86_400_000);
        const { txn } = post(ctx, {
            type: 'cashout_request',
            idempotencyKey: input.idempotencyKey,
            entries: [entry(A.payable(input.subject), -amount), entry(A.pending(input.subject), amount)],
            actor: input.actor,
            fromSubject: input.subject,
            metadata: { cashout_id: id, amount_bits: amount, value_cents: rates.valueCents(amount), escrow_until: escrowUntil, escrow_days: rates.escrowDays, rates: rates.snapshot() },
        });
        db.prepare(`INSERT INTO cashouts (id, subject, amount_bits, value_cents, status, payout_method, escrow_until, request_txn, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?)`).run(id, input.subject, amount, rates.valueCents(amount), JSON.stringify(method), escrowUntil, txn.id, iso(ms), iso(ms));
        const cashout = find(db, id);
        enqueue(ctx, { event_type: 'billing.cashout.requested', subject: { type: 'cashout', id }, payload: { cashout: eventView(cashout), transaction_id: txn.id } });
        return { cashout, replay: false };
    })();
}

function approve(ctx, input) {
    const { db, rates } = ctx;
    const ref = text(input.payout_reference, 'payout_reference', 200);
    if (!ref) fail(422, 'billing.payout_reference_required', 'approving a payout needs the payout reference from the provider');
    const provider = String(input.payout_provider || 'paypal').toLowerCase();
    return db.transaction(() => {
        const c = find(db, input.id);
        if (!c) fail(404, 'billing.cashout_not_found', `no cashout ${input.id}`);
        if (c.status === 'paid' && c.payout_reference === ref) return { cashout: c, replay: true };
        if (c.status !== 'requested') fail(409, 'billing.cashout_not_pending', `cashout ${c.id} is ${c.status}`);
        if (ctx.now() < Date.parse(c.escrow_until)) fail(409, 'billing.escrow_active', `cashout ${c.id} is in escrow until ${c.escrow_until}`, { escrow_until: c.escrow_until });
        const value = c.value_cents;
        const { txn } = post(ctx, {
            type: 'cashout_paid',
            idempotencyKey: input.idempotencyKey,
            entries: [
                entry(A.pending(c.subject), -c.amount_bits), entry(A.fxBits(), c.amount_bits),
                entry(A.fxCents(), -value), entry(A.clearing(`${provider}_payouts`), value),
            ],
            actor: input.actor,
            fromSubject: c.subject,
            provider: `${provider}_payouts`,
            receiptRef: `${provider}_payouts:${ref}`,
            metadata: { cashout_id: c.id, amount_bits: c.amount_bits, value_cents: value, payout_reference: ref, rates: rates.snapshot() },
        });
        db.prepare(`UPDATE cashouts SET status = 'paid', settle_txn = ?, payout_provider = ?, payout_reference = ?, decided_by = ?, updated_at = ? WHERE id = ?`)
            .run(txn.id, provider, ref, JSON.stringify(input.actor || {}), iso(ctx.now()), c.id);
        const cashout = find(db, c.id);
        enqueue(ctx, { event_type: 'billing.cashout.paid', subject: { type: 'cashout', id: c.id }, payload: { cashout: eventView(cashout), transaction_id: txn.id } });
        return { cashout, replay: false };
    })();
}

function deny(ctx, input) {
    const { db } = ctx;
    return db.transaction(() => {
        const c = find(db, input.id);
        if (!c) fail(404, 'billing.cashout_not_found', `no cashout ${input.id}`);
        if (c.status === 'denied') return { cashout: c, replay: true };
        if (c.status !== 'requested') fail(409, 'billing.cashout_not_pending', `cashout ${c.id} is ${c.status}`);
        const reason = text(input.reason, 'reason', 300);
        const { txn } = post(ctx, {
            type: 'cashout_denied',
            idempotencyKey: input.idempotencyKey,
            reversesTxn: c.request_txn,
            entries: [entry(A.pending(c.subject), -c.amount_bits), entry(A.payable(c.subject), c.amount_bits)],
            actor: input.actor,
            toSubject: c.subject,
            metadata: { cashout_id: c.id, amount_bits: c.amount_bits, reason },
        });
        db.prepare(`UPDATE cashouts SET status = 'denied', settle_txn = ?, reason = ?, decided_by = ?, updated_at = ? WHERE id = ?`)
            .run(txn.id, reason, JSON.stringify(input.actor || {}), iso(ctx.now()), c.id);
        const cashout = find(db, c.id);
        enqueue(ctx, { event_type: 'billing.cashout.denied', subject: { type: 'cashout', id: c.id }, payload: { cashout: eventView(cashout), transaction_id: txn.id } });
        enqueue(ctx, { event_type: 'billing.transaction.reversed', subject: { type: 'transaction', id: txn.id }, payload: { ...summary(txn), reverses_txn: c.request_txn } });
        return { cashout, replay: false };
    })();
}

function recycle(ctx, input) {
    const { db, rates } = ctx;
    const amount = positiveInt(input.amount, 'amount', rates.maxBits);
    return db.transaction(() => {
        const existing = db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing) return { txn: getTxn(db, existing.id), replay: true };
        requireFunds(db, A.payable(input.subject), amount, 'creator payable');
        const { txn } = post(ctx, {
            type: 'recycle',
            idempotencyKey: input.idempotencyKey,
            entries: [entry(A.payable(input.subject), -amount), entry(A.credit(input.subject), amount)],
            actor: input.actor,
            fromSubject: input.subject,
            toSubject: input.subject,
            metadata: { amount_bits: amount },
        });
        enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn) });
        return { txn, replay: false };
    })();
}

function list(db, { status, subject, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (subject) { where.push('subject = ?'); args.push(subject); }
    return db.prepare(`SELECT * FROM cashouts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC LIMIT ?`)
        .all(...args, Math.min(500, limit)).map(parse);
}

module.exports = { request, approve, deny, recycle, find, list, present };
