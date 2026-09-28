-- phase: expand
-- OpenVibe.Billing on PostgreSQL (ADR-035, roadmap WS-X2): the tables as they were on SQLite (converted by openvibe-sdk
-- tools/asyncify/sqlite-schema-to-pg: text COLLATE "C" compares like SQLite, integers are bigint, identities keep their ids),
-- then the openvibe-publishing stores and the openvibe-sdk inbox and outbox. Generated once on 2026-09-28; never edited after it runs.

-- SQLite's json_extract on the text columns (metadata, result, event): the value at a '$.a.b' path, as text (callers
-- cast numbers; a JSON true is 'true').
CREATE FUNCTION json_extract(t text, path text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_extract_path_text(t::jsonb, VARIADIC string_to_array(substr(path, 3), '.')) $$;

CREATE TABLE accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('user_credit', 'creator_payable', 'provider_clearing', 'platform_revenue', 'payouts_pending', 'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion')),
    owner_subject text COLLATE "C",
    currency text COLLATE "C" NOT NULL CHECK (currency IN ('vibes-bits', 'usd-cents')),
    created_at text COLLATE "C" NOT NULL,
    UNIQUE (kind, owner_subject, currency)
);

CREATE TABLE provider_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider text COLLATE "C" NOT NULL,
    provider_event_id text COLLATE "C" NOT NULL,
    type text COLLATE "C",
    payload_hash text COLLATE "C" NOT NULL,
    payload text COLLATE "C" NOT NULL,
    received_at text COLLATE "C" NOT NULL,
    processed_at text COLLATE "C",
    result text COLLATE "C",
    attempts bigint NOT NULL DEFAULT 0,
    last_error text COLLATE "C",
    UNIQUE (provider, provider_event_id)
);

CREATE TABLE transactions (
    id text COLLATE "C" PRIMARY KEY,
    type text COLLATE "C" NOT NULL CHECK (type IN ('purchase', 'donation', 'subscription', 'subscription_share', 'cashout_request', 'cashout_paid', 'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import')),
    status text COLLATE "C" NOT NULL DEFAULT 'settled' CHECK (status IN ('settled', 'imported')),
    idempotency_key text COLLATE "C" NOT NULL UNIQUE,
    reverses_txn text COLLATE "C" REFERENCES transactions (id),
    test bigint NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
    actor text COLLATE "C" NOT NULL DEFAULT '{}',
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    from_subject text COLLATE "C",
    to_subject text COLLATE "C",
    provider text COLLATE "C",
    receipt_ref text COLLATE "C",
    source_event_id bigint REFERENCES provider_events (id),
    created_at text COLLATE "C" NOT NULL
);

CREATE TABLE ledger_entries (
    txn_id text COLLATE "C" NOT NULL REFERENCES transactions (id),
    account_id bigint NOT NULL REFERENCES accounts (id),
    amount bigint NOT NULL CHECK (amount <> 0),
    PRIMARY KEY (txn_id, account_id)
);

CREATE TABLE account_balances (
    account_id bigint PRIMARY KEY REFERENCES accounts (id),
    balance bigint NOT NULL DEFAULT 0,
    updated_at text COLLATE "C"
);

CREATE TABLE external_receipts (
    receipt_ref text COLLATE "C" PRIMARY KEY,
    provider text COLLATE "C" NOT NULL,
    provider_event bigint NOT NULL REFERENCES provider_events (id),
    receiving_account text COLLATE "C",
    streamer_subject text COLLATE "C",
    amount_cents bigint NOT NULL,
    test bigint NOT NULL DEFAULT 0 CHECK (test IN (0, 1)),
    status text COLLATE "C" NOT NULL CHECK (status IN ('announced', 'not_announced')),
    reason text COLLATE "C",
    event_id text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);

CREATE TABLE provider_accounts (
    provider text COLLATE "C" NOT NULL,
    username text COLLATE "C" NOT NULL,
    account_id text COLLATE "C",
    subject text COLLATE "C" NOT NULL,
    source text COLLATE "C" NOT NULL,
    live_user_id bigint,
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (provider, username)
);

CREATE TABLE payment_intents (
    id text COLLATE "C" PRIMARY KEY,
    provider text COLLATE "C" NOT NULL,
    provider_ref text COLLATE "C",
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('purchase', 'subscription')),
    subject text COLLATE "C" NOT NULL,
    streamer_subject text COLLATE "C",
    amount_cents bigint NOT NULL,
    fee_cents bigint NOT NULL DEFAULT 0,
    bits bigint NOT NULL DEFAULT 0,
    route text COLLATE "C",
    auto_renew bigint NOT NULL DEFAULT 0,
    status text COLLATE "C" NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'settled', 'failed', 'expired', 'canceled', 'refunded')),
    settled_txn text COLLATE "C" REFERENCES transactions (id),
    legacy_order_id bigint UNIQUE,
    metadata text COLLATE "C" NOT NULL DEFAULT '{}',
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);

CREATE TABLE cashouts (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    amount_bits bigint NOT NULL CHECK (amount_bits > 0),
    value_cents bigint NOT NULL,
    status text COLLATE "C" NOT NULL CHECK (status IN ('requested', 'paid', 'denied')),
    payout_method text COLLATE "C" NOT NULL DEFAULT '{}',
    escrow_until text COLLATE "C" NOT NULL,
    request_txn text COLLATE "C" NOT NULL REFERENCES transactions (id),
    settle_txn text COLLATE "C" REFERENCES transactions (id),
    payout_provider text COLLATE "C",
    payout_reference text COLLATE "C",
    decided_by text COLLATE "C",
    reason text COLLATE "C",
    legacy_live_txn bigint UNIQUE,
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);

CREATE TABLE subscriptions (
    id text COLLATE "C" PRIMARY KEY,
    subscriber text COLLATE "C" NOT NULL,
    streamer text COLLATE "C" NOT NULL,
    tier bigint NOT NULL DEFAULT 1,
    provider text COLLATE "C" NOT NULL,
    provider_ref text COLLATE "C",
    route text COLLATE "C",
    status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'canceled', 'expired')),
    auto_renew bigint NOT NULL DEFAULT 0,
    cancel_at_period_end bigint NOT NULL DEFAULT 0,
    price_cents bigint NOT NULL DEFAULT 0,
    current_period_end text COLLATE "C",
    legacy_live_id bigint UNIQUE,
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    UNIQUE (subscriber, streamer)
);

CREATE TABLE entitlements (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    kind text COLLATE "C" NOT NULL,
    scope text COLLATE "C" NOT NULL,
    subscription_id text COLLATE "C" REFERENCES subscriptions (id),
    starts_at text COLLATE "C" NOT NULL,
    ends_at text COLLATE "C" NOT NULL,
    source_txn text COLLATE "C" REFERENCES transactions (id),
    revoked_at text COLLATE "C",
    revoked_reason text COLLATE "C",
    created_at text COLLATE "C" NOT NULL
);

CREATE TABLE idempotency_keys (
    key text COLLATE "C" PRIMARY KEY,
    request_hash text COLLATE "C" NOT NULL,
    method text COLLATE "C" NOT NULL,
    path text COLLATE "C" NOT NULL,
    status bigint NOT NULL,
    response text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL
);

CREATE TABLE settings (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK (id = 1),
    "freeze" bigint NOT NULL DEFAULT 0,
    freeze_reason text COLLATE "C",
    frozen_at text COLLATE "C",
    frozen_by text COLLATE "C"
);

CREATE TABLE reconciliation_runs (
    id text COLLATE "C" PRIMARY KEY,
    started_at text COLLATE "C" NOT NULL,
    finished_at text COLLATE "C" NOT NULL,
    ok bigint NOT NULL,
    report text COLLATE "C" NOT NULL
);

CREATE TABLE import_runs (
    id text COLLATE "C" PRIMARY KEY,
    source text COLLATE "C" NOT NULL,
    dry_run bigint NOT NULL,
    started_at text COLLATE "C" NOT NULL,
    finished_at text COLLATE "C",
    report text COLLATE "C"
);

CREATE TABLE import_holds (
    live_user_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    owner text COLLATE "C" NOT NULL,
    reason text COLLATE "C" NOT NULL,
    credit_bits bigint NOT NULL DEFAULT 0,
    payable_bits bigint NOT NULL DEFAULT 0,
    resolved_subject text COLLATE "C",
    first_seen_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL
);

CREATE TABLE outbox (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id text COLLATE "C" NOT NULL UNIQUE,
    event text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    sent_at text COLLATE "C",
    attempts bigint NOT NULL DEFAULT 0,
    last_error text COLLATE "C"
);

CREATE TABLE staff_audit (
    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id text COLLATE "C" NOT NULL UNIQUE,
    at text COLLATE "C" NOT NULL,
    actor_subject text COLLATE "C",
    actor_username text COLLATE "C",
    action text COLLATE "C" NOT NULL,
    target_type text COLLATE "C",
    target_id text COLLATE "C",
    reason text COLLATE "C",
    outcome text COLLATE "C" NOT NULL CHECK (outcome IN ('done', 'refused')),
    detail text COLLATE "C" NOT NULL DEFAULT '{}',
    request_id text COLLATE "C",
    ip_hash text COLLATE "C"
);

CREATE TABLE staff_sessions (
    id_hash text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    username text COLLATE "C",
    role text COLLATE "C" NOT NULL,
    csrf text COLLATE "C" NOT NULL,
    created_at text COLLATE "C" NOT NULL,
    expires_at text COLLATE "C" NOT NULL,
    revoked_at text COLLATE "C",
    ip_hash text COLLATE "C"
);

CREATE UNIQUE INDEX accounts_identity ON accounts (kind, COALESCE(owner_subject, ''), currency);
CREATE UNIQUE INDEX transactions_receipt ON transactions (receipt_ref) WHERE receipt_ref IS NOT NULL;
CREATE INDEX transactions_from ON transactions (from_subject);
CREATE INDEX transactions_to ON transactions (to_subject);
CREATE INDEX transactions_reverses ON transactions (reverses_txn);
CREATE INDEX transactions_event ON transactions (source_event_id);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id);
CREATE INDEX provider_events_pending ON provider_events (processed_at);
CREATE INDEX external_receipts_streamer ON external_receipts (streamer_subject);
CREATE INDEX provider_accounts_account ON provider_accounts (provider, account_id);
CREATE UNIQUE INDEX payment_intents_ref ON payment_intents (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payment_intents_subject ON payment_intents (subject);
CREATE INDEX cashouts_status ON cashouts (status);
CREATE INDEX cashouts_subject ON cashouts (subject);
CREATE INDEX subscriptions_provider_ref ON subscriptions (provider, provider_ref);
CREATE INDEX subscriptions_streamer ON subscriptions (streamer, status);
CREATE INDEX entitlements_lookup ON entitlements (subject, kind, scope);
CREATE INDEX entitlements_source ON entitlements (source_txn);
CREATE INDEX outbox_unsent ON outbox (sent_at, seq);
CREATE INDEX staff_audit_target ON staff_audit (target_type, target_id);
CREATE INDEX staff_sessions_expiry ON staff_sessions (expires_at);

CREATE FUNCTION ledger_entries_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger_entries are append-only'; RETURN NEW; END $$;
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_no_update();

CREATE FUNCTION ledger_entries_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger_entries are append-only'; RETURN OLD; END $$;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION ledger_entries_no_delete();

CREATE FUNCTION transactions_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'transactions are append-only; post a reversing transaction'; RETURN NEW; END $$;
CREATE TRIGGER transactions_no_update BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_no_update();

CREATE FUNCTION transactions_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'transactions are append-only; post a reversing transaction'; RETURN OLD; END $$;
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION transactions_no_delete();

CREATE FUNCTION provider_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'provider receipts are immutable'; RETURN NEW; END $$;
CREATE TRIGGER provider_events_immutable BEFORE UPDATE OF provider, provider_event_id, payload, payload_hash, received_at ON provider_events FOR EACH ROW EXECUTE FUNCTION provider_events_immutable();

CREATE FUNCTION provider_events_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'provider receipts are immutable'; RETURN OLD; END $$;
CREATE TRIGGER provider_events_no_delete BEFORE DELETE ON provider_events FOR EACH ROW EXECUTE FUNCTION provider_events_no_delete();

CREATE FUNCTION staff_audit_no_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'staff_audit is append-only'; RETURN NEW; END $$;
CREATE TRIGGER staff_audit_no_update BEFORE UPDATE ON staff_audit FOR EACH ROW EXECUTE FUNCTION staff_audit_no_update();

CREATE FUNCTION staff_audit_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'staff_audit is append-only'; RETURN OLD; END $$;
CREATE TRIGGER staff_audit_no_delete BEFORE DELETE ON staff_audit FOR EACH ROW EXECUTE FUNCTION staff_audit_no_delete();

-- Rows the SQLite boot seeded
INSERT INTO settings (id, "freeze", freeze_reason, frozen_at, frozen_by) VALUES
    (1, 0, NULL, NULL, NULL);
SELECT setval(pg_get_serial_sequence('settings', 'id'), (SELECT MAX(id) FROM settings));
