'use strict';

/**
 * OpenVibe.Billing database: PostgreSQL (ADR-035, roadmap WS-X2; ov_billing on the host's data role).
 *
 * The journal is three tables: accounts, transactions, ledger_entries. Every transaction's
 * entries sum to zero per currency (enforced in ledger.js, verified by reconcile.js), and the
 * journal is append-only: triggers refuse UPDATE/DELETE on ledger_entries and transactions.
 * Corrections are new, reversing transactions. account_balances is a cache of SUM(entries)
 * per account, updated in the same transaction as the entries and verified by
 * reconciliation.
 *
 * Operational state that does change (intents, provider events, cashouts, subscriptions,
 * entitlements) lives in its own tables; its money effects are always journal transactions.
 */
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const ACCOUNT_KINDS = ['user_credit', 'creator_payable', 'provider_clearing', 'platform_revenue', 'payouts_pending',
    'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion', 'promo_credit', 'promo_reserve'];
// The promo ledger's kinds (migrations/0003): their entries never share a transaction with any other kind.
const PROMO_KINDS = ['promo_credit', 'promo_reserve'];
const CURRENCIES = ['vibes-bits', 'usd-cents'];
const TXN_TYPES = ['purchase', 'donation', 'subscription', 'subscription_share', 'cashout_request', 'cashout_paid',
    'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import'];


const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations (migrations/NNNN_*.sql) run first, as the owner (DATABASE_DIRECT_URL), or on the embedded
 * handle. Money moves in serializable transactions (ledger.js money()).
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh billing)');
        const dir = process.env.BILLING_PGLITE_DIR || DEV_PGLITE;
        log.warn(`[Billing] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'billing', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'billing-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'billing', registry, log });
}

module.exports = { openDb, MIGRATIONS, ACCOUNT_KINDS, PROMO_KINDS, CURRENCIES, TXN_TYPES };
