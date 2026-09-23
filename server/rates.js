'use strict';

/**
 * Money arithmetic, from configured rates (config.rates). Every helper is integer-in,
 * integer-out; nothing here rounds twice.
 *
 *   value rate   bitsPerUsd bits = $1 of creator value (Live: 100, so 1 bit = 1 cent)
 *   price tiers  what a viewer pays per bit when buying (Live's volume discounts)
 */
function createRates(r) {
    const tiers = [...r.priceTiers].sort((a, b) => b.min - a.min);

    /** Creator/cashout value of `bits`, in USD cents. */
    const valueCents = (bits) => Math.round((bits * 100) / r.bitsPerUsd);
    /** Bits worth `cents` at the value rate (income converted into bits, e.g. a sub share). */
    const bitsForValueCents = (cents) => Math.max(0, Math.round((cents * r.bitsPerUsd) / 100));

    /** Purchase price (cents) of `bits` under the tiers. */
    function priceCents(bits) {
        const tier = tiers.find((t) => bits >= t.min) || tiers[tiers.length - 1];
        return Math.round(bits * tier.usd_per_bit * 100);
    }

    /** The most bits `cents` buys under the tiers (0 when too little). */
    function bitsForPriceCents(cents) {
        let best = 0;
        for (const t of tiers) {
            const b = Math.floor((cents + 1e-9) / (t.usd_per_bit * 100));
            if (b >= t.min && b > best && priceCents(b) <= cents) best = b;
        }
        return best;
    }

    /** Subscription split: the creator's share (bits) of a base price (cents). */
    const subShareBits = (baseCents) => bitsForValueCents(Math.floor((baseCents * r.subSharePct) / 100));
    const siteFeeCents = (baseCents) => Math.round((baseCents * r.siteRouteFeePct) / 100);

    /** Snapshot recorded on each transaction. */
    const snapshot = (extra = {}) => ({ bits_per_usd: r.bitsPerUsd, ...extra });

    return { ...r, valueCents, bitsForValueCents, priceCents, bitsForPriceCents, subShareBits, siteFeeCents, snapshot };
}

module.exports = { createRates };
