#!/usr/bin/env node
'use strict';
/**
 * The economy freeze from the host, without a service token (the same switch as
 * POST /api/v1/admin/freeze; ADR-012 rule 11).
 *
 *   node scripts/freeze.js status
 *   node scripts/freeze.js on "Live cutover"     writes refused (503 billing.frozen), reads served,
 *                                                webhooks stored (202) and held
 *   node scripts/freeze.js off                   the running service processes the held webhooks in
 *                                                arrival order on its next retry tick (≤ BILLING_WEBHOOK_RETRY_MS)
 */
const os = require('os');
const admin = require('../server/ops/admin');

/** The command on a database handle (the script opens the service's own; tests pass theirs). Returns what it prints. */
async function freeze([cmd = 'status', reason] = [], { db }) {
    if (!['status', 'on', 'off'].includes(cmd)) throw Object.assign(new Error('usage: freeze.js status | on "<reason>" | off'), { usage: true });
    const state = cmd === 'status'
        ? await admin.freezeState(db)
        : await admin.setFreeze({ db, now: () => Date.now() }, { on: cmd === 'on', reason: reason || null, actor: { principal: 'operator:cli', host: os.hostname(), user: os.userInfo().username } });
    const pending = (await db.prepare('SELECT COUNT(*) AS n FROM provider_events WHERE processed_at IS NULL').get()).n;
    return { ...state, held_webhooks: pending };
}

if (require.main === module) {
    (async () => {
        const { loadConfig } = require('../server/config');
        const { openDb } = require('../server/db');
        const args = process.argv.slice(2);
        if (!['status', 'on', 'off'].includes(args[0] || 'status')) { console.error('usage: freeze.js status | on "<reason>" | off'); process.exit(2); }
        const db = await openDb(loadConfig());
        try { console.log(JSON.stringify(await freeze(args, { db }))); } finally { await db.close(); }
    })().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { freeze };
