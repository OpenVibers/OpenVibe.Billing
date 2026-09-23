'use strict';

/**
 * Payment intents: a checkout that was started. The amount is computed here from the configured
 * rates (never taken from the client), and the provider reference is unique once set.
 *
 *   kind purchase      bits → price under the tiers
 *   kind subscription  sub price, plus the site-route fee when PowerChat routes through the site
 */
const { prefixedId, iso } = require('../ledger');
const { fail, positiveInt, userSubject } = require('./common');

function parse(row) {
    return row ? { ...row, auto_renew: !!row.auto_renew, metadata: JSON.parse(row.metadata || '{}') } : null;
}

/** By id, or by a Live order id for intents imported from payment_orders. */
function find(db, ref) {
    const s = String(ref || '');
    if (/^\d+$/.test(s)) return parse(db.prepare('SELECT * FROM payment_intents WHERE legacy_order_id = ?').get(Number(s)));
    return parse(db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(s));
}

function findByProviderRef(db, provider, ref) {
    return parse(db.prepare('SELECT * FROM payment_intents WHERE provider = ? AND provider_ref = ?').get(provider, ref));
}

function create(ctx, input) {
    const { db, rates } = ctx;
    const provider = String(input.provider || '').toLowerCase();
    if (!/^[a-z][a-z0-9_-]{1,39}$/.test(provider)) fail(422, 'billing.invalid_input', 'provider is required');
    const kind = input.kind;
    const subject = userSubject(input.subject, 'subject');
    const ms = ctx.now();
    const row = {
        id: prefixedId('pi', ms), provider, provider_ref: null, kind, subject, streamer_subject: null,
        amount_cents: 0, fee_cents: 0, bits: 0, route: null, auto_renew: input.auto_renew ? 1 : 0,
        metadata: {},
    };
    if (kind === 'purchase') {
        row.bits = positiveInt(input.bits, 'bits', rates.maxBits);
        if (row.bits < rates.minPurchaseBits) fail(422, 'billing.amount_too_small', `the minimum purchase is ${rates.minPurchaseBits} bits`);
        row.amount_cents = rates.priceCents(row.bits);
    } else if (kind === 'subscription') {
        row.streamer_subject = userSubject(input.streamer, 'streamer');
        if (row.streamer_subject === subject) fail(422, 'billing.self_dealing', 'you cannot subscribe to yourself');
        const base = rates.subPriceCents;
        row.route = input.route === 'direct' ? 'direct' : (provider === 'powerchat' ? 'site' : null);
        row.fee_cents = row.route === 'site' ? rates.siteFeeCents(base) : 0;
        row.amount_cents = base + row.fee_cents;
        // A direct subscription is paid to the streamer's own provider account. Without naming that
        // account, anyone's tip carrying the ref (to their OWN account) would grant the subscription.
        if (row.route === 'direct' && provider === 'powerchat') {
            const acct = String(input.receiving_account || '').trim().toLowerCase();
            if (!/^[a-z0-9_.-]{1,64}$/.test(acct)) fail(422, 'billing.invalid_input', "a direct PowerChat subscription needs receiving_account (the streamer's PowerChat username)");
            row.receiving_account = acct;
        }
    } else {
        fail(422, 'billing.invalid_input', "kind must be 'purchase' or 'subscription'");
    }
    row.metadata = { rates: rates.snapshot({ price_tiers: kind === 'purchase' ? rates.priceTiers : undefined, sub_share_pct: rates.subSharePct, site_route_fee_pct: rates.siteRouteFeePct }) };
    if (row.receiving_account) row.metadata.receiving_account = row.receiving_account;
    db.prepare(`INSERT INTO payment_intents (id, provider, provider_ref, kind, subject, streamer_subject, amount_cents, fee_cents, bits, route,
            auto_renew, status, metadata, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`).run(row.id, provider, kind, subject, row.streamer_subject,
        row.amount_cents, row.fee_cents, row.bits, row.route, row.auto_renew, JSON.stringify(row.metadata), iso(ms), iso(ms));
    return find(db, row.id);
}

/**
 * An intent imported from a Live payment order that Live had already credited before the cutover.
 * Its money effect lives in the imported history/opening balances, not in a Billing settlement, so
 * a provider delivery for it that reaches Billing afterwards (a retry of a delivery Live had
 * acknowledged, a manual resend) must not settle it again.
 */
function settledInLive(i) {
    return !!(i && i.legacy_order_id != null && i.status === 'settled' && !i.settled_txn);
}
function refuseIfSettledInLive(i) {
    if (settledInLive(i)) {
        fail(409, 'billing.intent_settled_in_live', `intent ${i.id} (Live order ${i.legacy_order_id}) was already credited by Live before the cutover; this delivery is held for review, not settled again`);
    }
}

function setProviderRef(ctx, id, ref) {
    ctx.db.prepare('UPDATE payment_intents SET provider_ref = ?, updated_at = ? WHERE id = ?').run(ref, iso(ctx.now()), id);
}
function mergeMetadata(ctx, id, extra) {
    const row = find(ctx.db, id);
    ctx.db.prepare('UPDATE payment_intents SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...row.metadata, ...extra }), iso(ctx.now()), id);
}
function setStatus(ctx, id, status) {
    ctx.db.prepare('UPDATE payment_intents SET status = ?, updated_at = ? WHERE id = ?').run(status, iso(ctx.now()), id);
}
function markSettled(ctx, id, txnId) {
    ctx.db.prepare("UPDATE payment_intents SET status = 'settled', settled_txn = ?, updated_at = ? WHERE id = ?").run(txnId, iso(ctx.now()), id);
}

function present(i) {
    if (!i) return null;
    return {
        id: i.id, provider: i.provider, provider_ref: i.provider_ref, kind: i.kind,
        subject: { type: 'user', id: i.subject }, streamer: i.streamer_subject ? { type: 'user', id: i.streamer_subject } : null,
        amount_cents: i.amount_cents, fee_cents: i.fee_cents, bits: i.bits, route: i.route, auto_renew: i.auto_renew,
        status: i.status, settled_txn: i.settled_txn || null, created_at: i.created_at,
        // PowerChat checkouts carry this in app_ref; the webhook echoes it back.
        checkout_ref: i.provider === 'powerchat' ? `${i.kind === 'purchase' ? 'pcorder' : 'pcsub'}:${i.id}` : undefined,
    };
}

module.exports = { find, findByProviderRef, create, setProviderRef, mergeMetadata, setStatus, markSettled, present, parse, settledInLive, refuseIfSettledInLive };
