'use strict';

/**
 * Operator controls: the economy freeze (ADR-012 rule 11) and manual adjustments.
 *
 * An adjustment is an explicit balanced transaction between two accounts of one currency, with a
 * mandatory reason — the only way an operator changes a balance (e.g. resolving a chargeback
 * flagged for review, or settling an import hold once its owner is known).
 */
const { post, getTxn, iso, money } = require('../ledger');
const { enqueue } = require('../outbox');
const { entry, fail, positiveInt, text } = require('./common');
const { ACCOUNT_KINDS, PROMO_KINDS, CURRENCIES } = require('../db');
const { summary } = require('./purchases');

async function freezeState(db) {
    const r = await db.prepare('SELECT * FROM settings WHERE id = 1').get();
    return { frozen: !!r.freeze, reason: r.freeze_reason || null, frozen_at: r.frozen_at || null, frozen_by: r.frozen_by ? JSON.parse(r.frozen_by) : null };
}

async function setFreeze(ctx, { on, reason, actor }) {
    const { db } = ctx;
    await db.prepare('UPDATE settings SET "freeze" = ?, freeze_reason = ?, frozen_at = ?, frozen_by = ? WHERE id = 1')
        .run(on ? 1 : 0, on ? text(reason, 'reason', 300) : null, on ? iso(ctx.now()) : null, on ? JSON.stringify(actor || {}) : null);
    return await freezeState(db);
}

function account(v, field) {
    if (!v || typeof v !== 'object') fail(422, 'billing.invalid_input', `${field} must be { kind, owner?, currency }`);
    if (!ACCOUNT_KINDS.includes(v.kind)) fail(422, 'billing.invalid_input', `${field}.kind must be one of ${ACCOUNT_KINDS.join(', ')}`);
    if (!CURRENCIES.includes(v.currency)) fail(422, 'billing.invalid_input', `${field}.currency must be one of ${CURRENCIES.join(', ')}`);
    return { kind: v.kind, owner: v.owner == null || v.owner === '' ? null : String(v.owner), currency: v.currency };
}

/** Move `amount` from `from` to `to` (same currency). */
async function adjust(ctx, input) {
    const from = account(input.from, 'from');
    const to = account(input.to, 'to');
    if (from.currency !== to.currency) fail(422, 'billing.invalid_input', 'an adjustment moves value within one currency');
    // Free allowance never becomes credit or money: a promo account is corrected only against the other promo kind.
    if (PROMO_KINDS.includes(from.kind) !== PROMO_KINDS.includes(to.kind)) {
        fail(422, 'billing.promo_isolated', 'promo_credit and promo_reserve adjust only against each other; free allowance never becomes credit or money');
    }
    const amount = positiveInt(input.amount, 'amount', 1_000_000_000);
    const reason = text(input.reason, 'reason', 500);
    if (!reason) fail(422, 'billing.invalid_input', 'an adjustment needs a reason');
    return await money(ctx.db, async () => {
        const existing = await ctx.db.prepare('SELECT id FROM transactions WHERE idempotency_key = ?').get(input.idempotencyKey);
        if (existing) return { txn: await getTxn(ctx.db, existing.id), replay: true };
        const { txn } = await post(ctx, {
            type: 'adjustment',
            idempotencyKey: input.idempotencyKey,
            entries: [entry(from, -amount), entry(to, amount)],
            actor: input.actor,
            fromSubject: from.owner && from.owner.startsWith('usr_') ? from.owner : null,
            toSubject: to.owner && to.owner.startsWith('usr_') ? to.owner : null,
            metadata: { reason, amount, currency: from.currency, relates_to: input.relatesTo || null },
        });
        await enqueue(ctx, { event_type: 'billing.transaction.settled', subject: { type: 'transaction', id: txn.id }, payload: summary(txn) });
        return { txn, replay: false };
    });
}

module.exports = { freezeState, setFreeze, adjust };
