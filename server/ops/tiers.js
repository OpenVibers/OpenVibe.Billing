'use strict';

/**
 * Creator-priced subscription tiers (openvibe-contracts 0.201.0, billing.tier.manage). The product where a creator
 * sells memberships (OpenVibe.VIP) sets each tier's monthly price; Billing keeps it and charges it (ADR-012: Billing
 * prices, products never do).
 *
 *   tier 1 without a row      the site's default subscription price (rates.subPriceCents): nothing changes for a
 *                             creator who sets no tiers
 *   another tier without one  not for sale (billing.tier_unknown)
 *   archived                  no new subscriptions (billing.tier_archived); running ones renew at their own price
 *
 * A price stays within rates.tierMinCents..tierMaxCents; a creator sells at most rates.maxTiers tiers.
 */
const { iso } = require('../ledger');
const { fail, positiveInt, userSubject } = require('./common');

const STATUSES = ['active', 'archived'];

function present(row) {
    return row ? { tier: Number(row.tier), price_cents: Number(row.price_cents), status: row.status, updated_at: row.updated_at } : null;
}

/** A tier number from a body or path (1 when absent), within the configured maximum. */
function tierOf(rates, v, { required = false } = {}) {
    if (v == null || v === '') {
        if (required) fail(422, 'billing.invalid_input', 'tier is required');
        return 1;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1 || n > rates.maxTiers) fail(422, 'billing.invalid_input', `tier must be an integer from 1 to ${rates.maxTiers}`);
    return n;
}

async function find(db, streamer, tier) {
    return await db.prepare('SELECT * FROM subscription_tiers WHERE streamer = ? AND tier = ?').get(streamer, tier);
}

async function list(ctx, streamerRef) {
    const streamer = userSubject(streamerRef, 'streamer');
    const rows = await ctx.db.prepare('SELECT * FROM subscription_tiers WHERE streamer = ? ORDER BY tier').all(streamer);
    const r = ctx.rates;
    return {
        streamer: { type: 'user', id: streamer }, tiers: rows.map(present),
        default_price_cents: r.subPriceCents, min_price_cents: r.tierMinCents, max_price_cents: r.tierMaxCents, max_tiers: r.maxTiers,
    };
}

/** The monthly price of a new subscription to `tier` of `streamer`, or a refusal when that tier is not for sale. */
async function priceFor(ctx, streamer, tier) {
    const row = await find(ctx.db, streamer, tier);
    if (row) {
        if (row.status !== 'active') fail(409, 'billing.tier_archived', `tier ${tier} of this creator is no longer sold`);
        return Number(row.price_cents);
    }
    if (tier === 1) return ctx.rates.subPriceCents;
    fail(422, 'billing.tier_unknown', `this creator sells no tier ${tier}`);
}

/** Set one tier's price (and status). Returns the tier as presented. */
async function set(ctx, { streamer: streamerRef, tier: tierValue, priceCents, status, actor }) {
    const { db, rates } = ctx;
    const streamer = userSubject(streamerRef, 'streamer');
    const tier = tierOf(rates, tierValue, { required: true });
    const price = positiveInt(priceCents, 'price_cents', rates.tierMaxCents);
    if (price < rates.tierMinCents) fail(422, 'billing.invalid_amount', `price_cents must be at least ${rates.tierMinCents}`);
    const st = status == null || status === '' ? 'active' : String(status);
    if (!STATUSES.includes(st)) fail(422, 'billing.invalid_input', `status must be one of ${STATUSES.join(', ')}`);
    const at = iso(ctx.now());
    const by = actor ? (actor.on_behalf_of && actor.on_behalf_of.id) || actor.principal || null : null;
    await db.prepare(`INSERT INTO subscription_tiers (streamer, tier, price_cents, status, updated_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (streamer, tier) DO UPDATE SET price_cents = excluded.price_cents, status = excluded.status,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(streamer, tier, price, st, by, at, at);
    return present(await find(db, streamer, tier));
}

module.exports = { list, set, priceFor, tierOf, find, present, STATUSES };
