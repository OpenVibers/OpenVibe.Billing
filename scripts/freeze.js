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
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const admin = require('../server/ops/admin');

const [cmd = 'status', reason] = process.argv.slice(2);
if (!['status', 'on', 'off'].includes(cmd)) { console.error('usage: freeze.js status | on "<reason>" | off'); process.exit(2); }
const config = loadConfig();
const db = openDb(config.dbPath);
const os = require('os');
const state = cmd === 'status'
    ? admin.freezeState(db)
    : admin.setFreeze({ db, now: () => Date.now() }, { on: cmd === 'on', reason: reason || null, actor: { principal: 'operator:cli', host: os.hostname(), user: os.userInfo().username } });
const pending = db.prepare('SELECT COUNT(*) AS n FROM provider_events WHERE processed_at IS NULL').get().n;
console.log(JSON.stringify({ ...state, held_webhooks: pending }));
db.close();
