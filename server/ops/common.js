'use strict';

/**
 * Shared pieces of every money operation: account names, input checks, the freeze guard and
 * the "money arrived from a provider" entry shape.
 */
const { validate } = require('openvibe-contracts');
const { BillingError } = require('../ledger');

const BITS = 'vibes-bits';
const CENTS = 'usd-cents';
// The largest single provider receipt Billing accepts ($1,000,000). Anything above is refused
// (a provider event is then rejected and listed for review), never booked.
const MAX_RECEIPT_CENTS = 100_000_000;

/** Account addresses. owner is a subject id, a provider slug, 'hold:live:<id>' or null (platform). */
const A = {
    credit: (s) => ({ kind: 'user_credit', owner: s, currency: BITS }),
    payable: (s) => ({ kind: 'creator_payable', owner: s, currency: BITS }),
    pending: (s) => ({ kind: 'payouts_pending', owner: s, currency: BITS }),
    clearing: (provider) => ({ kind: 'provider_clearing', owner: provider, currency: CENTS }),
    revenue: (currency) => ({ kind: 'platform_revenue', owner: null, currency }),
    refunds: () => ({ kind: 'refunds', owner: null, currency: CENTS }),
    loss: () => ({ kind: 'chargeback_loss', owner: null, currency: CENTS }),
    fxBits: () => ({ kind: 'fx_conversion', owner: null, currency: BITS }),
    fxCents: () => ({ kind: 'fx_conversion', owner: null, currency: CENTS }),
    importAdj: (currency) => ({ kind: 'import_adjustment', owner: null, currency }),
};
const entry = (account, amount) => ({ ...account, amount });

/**
 * Money received through `provider` (paidCents) that becomes `bits` in `target`; whatever the
 * payment exceeds the bits' value by is platform revenue. Balanced per currency:
 *   usd-cents:  clearing −paid, revenue +(paid − value), fx +value
 *   vibes-bits: fx −bits, target +bits
 */
function receiptEntries(rates, { provider, paidCents, bits, target }) {
    const value = rates.valueCents(bits);
    const revenue = paidCents - value;
    if (revenue < 0) throw new BillingError(422, 'billing.overcredit', `payment of ${paidCents} cents cannot back ${bits} bits (${value} cents of value)`);
    return [
        entry(A.clearing(provider), -paidCents),
        entry(A.revenue(CENTS), revenue),
        entry(A.fxCents(), value),
        entry(A.fxBits(), -bits),
        entry(target, bits),
    ];
}

function fail(status, code, detail, extra) { throw new BillingError(status, code, detail, extra); }

/** A SubjectRef (or its id string) of a user → the subject id. */
function userSubject(v, field = 'subject') {
    const ref = typeof v === 'string' ? { type: v.startsWith('gst_') ? 'guest' : 'user', id: v } : v;
    const r = validate('identity.subject-ref@1', ref);
    if (!r.valid) fail(422, 'billing.invalid_subject', `${field} must be a SubjectRef ({ type: 'user', id: 'usr_…' })`);
    if (ref.type !== 'user') fail(422, 'billing.invalid_subject', `${field} must be a user subject; ${ref.type} subjects hold no money`);
    return ref.id;
}

/** A positive safe integer (never a float, never past 2^53 where JS arithmetic stops being exact). */
function positiveInt(v, field, max) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) fail(422, 'billing.invalid_amount', `${field} must be a positive integer`);
    if (max && n > max) fail(422, 'billing.invalid_amount', `${field} exceeds the maximum of ${max}`);
    return n;
}

function text(v, field, max = 300) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    if (s.length > max) fail(422, 'billing.invalid_input', `${field} must be ${max} characters or fewer`);
    return s || null;
}

function isFrozen(db) {
    return !!db.prepare('SELECT freeze FROM settings WHERE id = 1').get().freeze;
}
function assertNotFrozen(ctx) {
    if (isFrozen(ctx.db)) fail(503, 'billing.frozen', 'the economy is frozen: writes are refused, reads are served');
}

/** Movement summary for a subject from a transaction's entries (used in API responses). */
function subjectRef(id) { return id ? { type: 'user', id } : null; }

module.exports = { A, BITS, CENTS, MAX_RECEIPT_CENTS, entry, receiptEntries, fail, userSubject, positiveInt, text, isFrozen, assertNotFrozen, subjectRef };
