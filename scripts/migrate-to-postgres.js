#!/usr/bin/env node
'use strict';
/**
 * The one-time move of Billing's SQLite ledger (BILLING_DB_PATH) into its PostgreSQL schema (ADR-035; the procedure is
 * openvibe-sdk docs/migrating-to-postgresql.md, section 6, carried out by openvibe-sdk/db runSqliteMigration).
 *
 *   node scripts/migrate-to-postgres.js [--sqlite <file>] [--pglite] [--json] [--replace-ledger]
 *
 * Applies migrations/ as the owner (DATABASE_DIRECT_URL), copies every table into emptied tables, verifies row counts
 * and checksums, and exits 1 unless everything verified. The SQLite file is opened read-only. Every table keeps its
 * name and columns; the append-only triggers guard UPDATE and DELETE, so the TRUNCATE that empties a table and the
 * copy's INSERTs pass them.
 */
const { runSqliteMigration } = require('openvibe-sdk/db');
const { loadConfig } = require('../server/config');
const { MIGRATIONS } = require('../server/db');

const TABLES = {};

/**
 * The copy empties its target tables first (a rehearsal can be repeated). Once PostgreSQL holds a journal of its own,
 * that would erase money records: it refuses unless --replace-ledger says the rows there are to go.
 */
async function refuseOverLiveLedger(directUrl) {
    if (!directUrl || process.argv.includes('--pglite') || process.argv.includes('--replace-ledger')) return;
    const { createDb } = require('openvibe-sdk/db');
    const db = createDb({ url: directUrl, service: 'billing-migrate-check', max: 1 });
    try {
        const t = await db.prepare("SELECT to_regclass('transactions') IS NOT NULL AS present").get();
        const n = t.present ? Number((await db.prepare('SELECT COUNT(*) AS n FROM transactions').get()).n) : 0;
        if (n > 0) throw new Error(`PostgreSQL already holds ${n} ledger transaction(s): refusing to replace them (--replace-ledger to do it anyway)`);
    } finally { await db.close(); }
}

if (require.main === module) {
    const config = loadConfig();
    refuseOverLiveLedger(config.db.directUrl)
        .then(() => runSqliteMigration({ service: 'billing', sqlite: config.dbPath, directUrl: config.db.directUrl, migrations: MIGRATIONS, tables: TABLES }))
        .then((code) => process.exit(code), (err) => { console.error(`migrate-to-postgres failed: ${err.message}`); process.exit(1); });
}

module.exports = { TABLES };
