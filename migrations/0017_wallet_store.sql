-- phase: expand
-- Immutable Inventory order snapshots and recoverable Network OpenCoins debits.
CREATE TABLE wallet_store_payments (
    purchase_id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    currency text NOT NULL CHECK (currency IN ('vibes', 'coins')),
    amount bigint NOT NULL CHECK (amount > 0),
    item_id text NOT NULL,
    name text NOT NULL,
    payment_id text,
    created_at timestamptz NOT NULL
);
CREATE INDEX wallet_store_payments_subject ON wallet_store_payments(subject);
CREATE TABLE wallet_checkouts (
    subject text COLLATE "C" NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    response jsonb,
    created_at timestamptz NOT NULL,
    PRIMARY KEY(subject, idempotency_key)
);
