#!/usr/bin/env node
'use strict';
/**
 * Import OpenVibe.Live's money state into Billing (ADR-012 migration).
 *
 *   node scripts/import-live.js --live-db /path/to/live-snapshot.db [--dry-run] [--json]
 *   node scripts/import-live.js --live-db /path/to/live-snapshot.db --accounts-only [--dry-run] [--json]
 *
 * --accounts-only refreshes only provider_accounts from Live's powerchat_connections (who an
 * EXTERNAL PowerChat tip belongs to); no money, no reconciliation. Safe to run daily after cutover.
 *
 * --live-db must be a COPY of live.db (e.g. `sqlite3 live.db ".backup live-snapshot.db"`); it is
 * opened read-only. Live user ids are resolved to Network subjects through resolve-batch with this
 * service's client credentials (OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET, capability
 * identity.subject.resolve). The report is printed and stored in import_runs; a reconciliation run
 * follows every real import. Safe to re-run: a second run over the same snapshot changes nothing.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createRates } = require('../server/rates');
const { createIdentity } = require('../server/network');
const { importLive, importProviderAccounts } = require('../server/importer/live');
const { reconcile } = require('../server/reconcile');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

async function main() {
    const livePath = opt('live-db');
    if (!livePath) { console.error('usage: import-live.js --live-db <snapshot path> [--dry-run] [--json]'); process.exit(2); }
    const config = loadConfig();
    if (path.resolve(livePath) === path.resolve(config.dbPath)) throw new Error('--live-db points at the Billing database');
    const live = new Database(livePath, { readonly: true, fileMustExist: true });
    const db = openDb(config.dbPath);
    const ctx = { db, config, rates: createRates(config.rates), now: () => Date.now(), log: console };
    const identity = createIdentity(config);
    if (flag('accounts-only')) {
        const r = await importProviderAccounts(ctx, { live, resolveLiveUsers: identity.resolveLiveUsers, dryRun: flag('dry-run') });
        const a = r.provider_accounts;
        if (flag('json')) console.log(JSON.stringify(r, null, 2));
        else {
            console.log(`provider accounts ${r.run_id}${r.dry_run ? ' (DRY RUN — nothing kept)' : ''}: ${a.mapped} mapped, ${a.unchanged} unchanged, ${a.kept_admin.length} kept (set by an operator)`);
            for (const u of a.unmapped) console.log(`    unmapped: live user ${u.live_user_id} (${u.username}): ${u.reason}`);
        }
        live.close();
        db.close();
        return;
    }
    const report = await importLive(ctx, { live, resolveLiveUsers: identity.resolveLiveUsers, dryRun: flag('dry-run') });
    const rec = flag('dry-run') ? null : reconcile(ctx, { trigger: 'import' });
    if (flag('json')) console.log(JSON.stringify({ import: report, reconciliation: rec }, null, 2));
    else {
        console.log(`import ${report.run_id}${report.dry_run ? ' (DRY RUN — nothing kept)' : ''}`);
        console.log(`  live snapshot: ${JSON.stringify(report.counts.live)}; identities ${JSON.stringify(report.counts.identities)}`);
        console.log(`  new: ${report.new_transactions} transactions, ${report.counts.intents_new} intents, ${report.counts.receipts_new} receipts; subscriptions ${report.subscriptions.imported} imported / ${report.subscriptions.updated} updated`);
        console.log(`  opening adjustments (${report.adjustments.length}):`);
        for (const a of report.adjustments) console.log(`    live user ${a.live_user_id} (${a.username}) ${a.account}: history ${a.replayed_history} → column ${a.live_column} (adjust ${a.adjustment > 0 ? '+' : ''}${a.adjustment})`);
        console.log(`  holds (unmapped, kept on hold accounts): ${report.holds.length}`);
        for (const h of report.holds) console.log(`    live user ${h.live_user_id} (${h.username || '?'}): credit ${h.credit_bits}, payable ${h.payable_bits}`);
        console.log(`  duplicate provider refs: ${report.duplicate_provider_refs.length}; route markers parsed: ${report.route_markers}`);
        console.log(`  unreplayable history rows: ${report.unreplayable.length}; anomalies: ${report.anomalies.length}`);
        const pa = report.provider_accounts;
        if (pa) console.log(`  PowerChat accounts: ${pa.mapped} mapped, ${pa.unchanged} unchanged, ${pa.unmapped.length} unmapped, ${pa.kept_admin.length} kept (operator)`);
        if (rec) console.log(`  reconciliation ${rec.id}: ${rec.ok ? 'OK' : 'FAILED'} (${rec.checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'all checks pass'})`);
    }
    live.close();
    db.close();
    if (rec && !rec.ok) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
