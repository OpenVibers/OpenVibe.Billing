'use strict';

/**
 * OpenVibe.Billing database (ADR-007: one SQLite database per service, BILLING_DB_PATH).
 *
 * The journal is three tables: accounts, transactions, ledger_entries. Every transaction's
 * entries sum to zero per currency (enforced in ledger.js, verified by reconcile.js), and the
 * journal is append-only: triggers refuse UPDATE/DELETE on ledger_entries and transactions.
 * Corrections are new, reversing transactions. account_balances is a cache of SUM(entries)
 * per account, updated in the same SQLite transaction as the entries and verified by
 * reconciliation.
 *
 * Operational state that does change (intents, provider events, cashouts, subscriptions,
 * entitlements) lives in its own tables; its money effects are always journal transactions.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ACCOUNT_KINDS = ['user_credit', 'creator_payable', 'provider_clearing', 'platform_revenue', 'payouts_pending',
    'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion'];
const CURRENCIES = ['vibes-bits', 'usd-cents'];
const TXN_TYPES = ['purchase', 'donation', 'subscription', 'subscription_share', 'cashout_request', 'cashout_paid',
    'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import'];

const inList = (xs) => xs.map((x) => `'${x}'`).join(', ');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN (${inList(ACCOUNT_KINDS)})),
    owner_subject TEXT,
    currency TEXT NOT NULL CHECK (currency IN (${inList(CURRENCIES)})),
    created_at TEXT NOT NULL,
    UNIQUE (kind, owner_subject, currency)
);
-- SQLite treats NULLs as distinct in UNIQUE; platform accounts (owner NULL) need this one.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_identity ON accounts (kind, COALESCE(owner_subject, ''), currency);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN (${inList(TXN_TYPES)})),
    status TEXT NOT NULL DEFAULT 'settled' CHECK (status IN ('settled', 'imported')),
    idempotency_key TEXT NOT NULL UNIQUE,
    reverses_txn TEXT REFERENCES transactions (id),
    test INTEGER NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
    actor TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    from_subject TEXT,
    to_subject TEXT,
    provider TEXT,
    receipt_ref TEXT,
    source_event_id INTEGER REFERENCES provider_events (id),
    created_at TEXT NOT NULL
);
-- One settlement per provider payment, whatever event or retry carried it.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_receipt ON transactions (receipt_ref) WHERE receipt_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_from ON transactions (from_subject);
CREATE INDEX IF NOT EXISTS transactions_to ON transactions (to_subject);
CREATE INDEX IF NOT EXISTS transactions_reverses ON transactions (reverses_txn);
CREATE INDEX IF NOT EXISTS transactions_event ON transactions (source_event_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
    txn_id TEXT NOT NULL REFERENCES transactions (id),
    account_id INTEGER NOT NULL REFERENCES accounts (id),
    amount INTEGER NOT NULL CHECK (amount <> 0),
    PRIMARY KEY (txn_id, account_id)
);
CREATE INDEX IF NOT EXISTS ledger_entries_account ON ledger_entries (account_id);

CREATE TABLE IF NOT EXISTS account_balances (
    account_id INTEGER PRIMARY KEY REFERENCES accounts (id),
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);

CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger_entries are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transactions_no_update BEFORE UPDATE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are append-only; post a reversing transaction'); END;
CREATE TRIGGER IF NOT EXISTS transactions_no_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are append-only; post a reversing transaction'); END;

CREATE TABLE IF NOT EXISTS provider_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    type TEXT,
    payload_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    result TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS provider_events_pending ON provider_events (processed_at);
CREATE TRIGGER IF NOT EXISTS provider_events_immutable BEFORE UPDATE OF provider, provider_event_id, payload, payload_hash, received_at ON provider_events
BEGIN SELECT RAISE(ABORT, 'provider receipts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS provider_events_no_delete BEFORE DELETE ON provider_events
BEGIN SELECT RAISE(ABORT, 'provider receipts are immutable'); END;

CREATE TABLE IF NOT EXISTS payment_intents (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_ref TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('purchase', 'subscription')),
    subject TEXT NOT NULL,
    streamer_subject TEXT,
    amount_cents INTEGER NOT NULL,
    fee_cents INTEGER NOT NULL DEFAULT 0,
    bits INTEGER NOT NULL DEFAULT 0,
    route TEXT,
    auto_renew INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'settled', 'failed', 'expired', 'canceled', 'refunded')),
    settled_txn TEXT REFERENCES transactions (id),
    legacy_order_id INTEGER UNIQUE,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_ref ON payment_intents (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_intents_subject ON payment_intents (subject);

CREATE TABLE IF NOT EXISTS cashouts (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    amount_bits INTEGER NOT NULL CHECK (amount_bits > 0),
    value_cents INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('requested', 'paid', 'denied')),
    payout_method TEXT NOT NULL DEFAULT '{}',
    escrow_until TEXT NOT NULL,
    request_txn TEXT NOT NULL REFERENCES transactions (id),
    settle_txn TEXT REFERENCES transactions (id),
    payout_provider TEXT,
    payout_reference TEXT,
    decided_by TEXT,
    reason TEXT,
    legacy_live_txn INTEGER UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cashouts_status ON cashouts (status);
CREATE INDEX IF NOT EXISTS cashouts_subject ON cashouts (subject);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    subscriber TEXT NOT NULL,
    streamer TEXT NOT NULL,
    tier INTEGER NOT NULL DEFAULT 1,
    provider TEXT NOT NULL,
    provider_ref TEXT,
    route TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'canceled', 'expired')),
    auto_renew INTEGER NOT NULL DEFAULT 0,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    price_cents INTEGER NOT NULL DEFAULT 0,
    current_period_end TEXT,
    legacy_live_id INTEGER UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subscriber, streamer)
);
CREATE INDEX IF NOT EXISTS subscriptions_provider_ref ON subscriptions (provider, provider_ref);
CREATE INDEX IF NOT EXISTS subscriptions_streamer ON subscriptions (streamer, status);

CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    subscription_id TEXT REFERENCES subscriptions (id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    source_txn TEXT REFERENCES transactions (id),
    revoked_at TEXT,
    revoked_reason TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entitlements_lookup ON entitlements (subject, kind, scope);
CREATE INDEX IF NOT EXISTS entitlements_source ON entitlements (source_txn);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    freeze INTEGER NOT NULL DEFAULT 0,
    freeze_reason TEXT,
    frozen_at TEXT,
    frozen_by TEXT
);
INSERT OR IGNORE INTO settings (id, freeze) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
    id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    report TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_runs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    dry_run INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    report TEXT
);

CREATE TABLE IF NOT EXISTS import_holds (
    live_user_id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    reason TEXT NOT NULL,
    credit_bits INTEGER NOT NULL DEFAULT 0,
    payable_bits INTEGER NOT NULL DEFAULT 0,
    resolved_subject TEXT,
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_unsent ON outbox (sent_at, seq);
`;

function openDb(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return db;
}

module.exports = { openDb, ACCOUNT_KINDS, CURRENCIES, TXN_TYPES };
