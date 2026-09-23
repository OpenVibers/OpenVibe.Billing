#!/usr/bin/env node
'use strict';
/**
 * Run a reconciliation against BILLING_DB_PATH, store it in reconciliation_runs and print it.
 *   node scripts/reconcile.js [--json]      exit 1 when any check fails
 */
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createRates } = require('../server/rates');
const { reconcile } = require('../server/reconcile');

const config = loadConfig();
const db = openDb(config.dbPath);
const report = reconcile({ db, config, rates: createRates(config.rates), now: () => Date.now() }, { trigger: 'script' });
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
    console.log(`reconciliation ${report.id}: ${report.ok ? 'OK' : 'FAILED'}`);
    for (const c of report.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.ok ? '' : ` ${JSON.stringify(c.detail)}`}`);
    const w = report.warnings;
    console.log(`  warnings: ${w.negative_balances.length} negative balances, ${w.unprocessed_events.length} unprocessed events, ${w.rejected_events.length} rejected events, ` +
        `${w.events_for_review.length + w.transactions_for_review.length} for review, ${w.import_holds.length} import holds`);
    console.log(`  EXTERNAL receipts (test excluded): ${report.totals.external_receipts}, announced ${report.totals.external_announced}`);
    console.log(`  totals (test excluded): ${JSON.stringify(report.totals)}`);
}
db.close();
process.exit(report.ok ? 0 : 1);
