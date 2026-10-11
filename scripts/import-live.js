#!/usr/bin/env node
'use strict';
/**
 * Import OpenVibe.Live's money state into Billing (ADR-012 migration).
 *
 *   LIVE_DATABASE_URL=… node scripts/import-live.js [--dry-run] [--json]
 *   LIVE_DATABASE_URL=… node scripts/import-live.js --accounts-only [--dry-run] [--json]
 *   (or --live-env <Live's env file> where this user can read it; docs/live-cutover.md has the billing_live helper)
 *
 * --accounts-only refreshes only provider_accounts from Live's powerchat_connections (who an
 * EXTERNAL PowerChat tip belongs to); no money, no reconciliation. Safe to run daily after cutover.
 *
 * Live's database is OpenVibe.Live's PostgreSQL (`ov_live`). Its URL is LIVE_DATABASE_URL, or the DATABASE_URL line
 * of the env file --live-env names (Live's own, /etc/openvibe/live.env); it is never printed and never passed on a
 * command line. Every read runs in one REPEATABLE READ, READ ONLY transaction (server/importer/live-source.js), so
 * the import sees one moment of Live and cannot write there. Live user ids are resolved to Network subjects through resolve-batch with this
 * service's client credentials (OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET, capability
 * identity.subject.resolve). The report is printed and stored in import_runs; a reconciliation run
 * follows every real import. Safe to re-run: a second run over the same snapshot changes nothing.
 */
const fs = require('fs');
const { loadConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createRates } = require('../server/rates');
const { createIdentity } = require('../server/network');
const { importLive, importProviderAccounts } = require('../server/importer/live');
const { openLiveSource } = require('../server/importer/live-source');
const { reconcile } = require('../server/reconcile');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const flag = (name) => args.includes(`--${name}`);

/** Live's database URL: LIVE_DATABASE_URL, else the DATABASE_URL line of the --live-env file. Never printed. */
function liveUrl() {
    if (process.env.LIVE_DATABASE_URL) return process.env.LIVE_DATABASE_URL;
    const file = opt('live-env');
    if (!file) return null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
        if (m) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2') || null;
    }
    return null;
}

async function main() {
    if (args.includes('--live-db')) { console.error('--live-db is gone: Live runs on PostgreSQL; use --live-env /etc/openvibe/live.env (or LIVE_DATABASE_URL)'); process.exit(2); }
    const url = liveUrl();
    if (!url) { console.error('usage: import-live.js --live-env <Live env file> [--dry-run] [--json] [--accounts-only]  (or set LIVE_DATABASE_URL)'); process.exit(2); }
    const config = loadConfig();
    const live = await openLiveSource({ url });
    const db = await openDb(config);
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
        await live.close();
        db.close();
        return;
    }
    const report = await importLive(ctx, { live, resolveLiveUsers: identity.resolveLiveUsers, dryRun: flag('dry-run') });
    const rec = flag('dry-run') ? null : await reconcile(ctx, { trigger: 'import' });
    if (flag('json')) console.log(JSON.stringify({ import: report, reconciliation: rec }, null, 2));
    else {
        console.log(`import ${report.run_id}${report.dry_run ? ' (DRY RUN — nothing kept)' : ''}`);
        console.log(`  live database: ${JSON.stringify(report.counts.live)}; identities ${JSON.stringify(report.counts.identities)}`);
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
    await live.close();
    db.close();
    if (rec && !rec.ok) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
