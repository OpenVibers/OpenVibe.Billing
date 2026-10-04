#!/usr/bin/env node
'use strict';
/**
 * Load reviewed rate cards into Billing (plan T5 step 6). The only way a rate card reaches the ledger: a card is a
 * price, changed only by review and never written by an AI or a request on its own (platform.rate-card@1).
 *
 *   OV_RATE_CARDS=/etc/openvibe/rate-cards.json node scripts/load-rate-cards.js [--dry-run]
 *   OV_RATE_CARDS='[{"id": "…", …}]' node scripts/load-rate-cards.js
 *
 * Every card is validated against platform.rate-card@1 first; one invalid card loads nothing. A card is upserted by
 * id. Readings that were left unrated for want of a matching card become due again (the sweep rates them on its
 * next pass, if BILLING_RATING_INTERVAL_MS is on, or POST /api/v1/admin/rate). Prints { loaded, rearmed }.
 */
const rating = require('../server/ops/rating');

/** The command on a database handle (the script opens the service's own; tests pass theirs). */
async function load({ cards: source, dryRun = false }, { db, now = () => Date.now() }) {
    const cards = rating.parseCards(source);
    if (!cards.length) throw Object.assign(new Error('OV_RATE_CARDS is empty: no rate card to load (nothing is ever charged without one)'), { usage: true });
    return await rating.loadCards({ db, now }, cards, { dryRun });
}

if (require.main === module) {
    (async () => {
        const { loadConfig } = require('../server/config');
        const { openDb } = require('../server/db');
        const config = loadConfig();
        const db = await openDb(config);
        try {
            console.log(JSON.stringify(await load({ cards: config.rating.cards, dryRun: process.argv.includes('--dry-run') }, { db })));
        } finally { await db.close(); }
    })().catch((err) => { console.error(err.usage ? err.message : (err.detail || err)); process.exit(err.usage ? 2 : 1); });
}

module.exports = { load };
