-- phase: expand
-- D12: Balance and Vibes.
--
-- Balance accounts are usd_credit owned by user:<usr_id> (a person) or project:<prj_id> (a project); sandbox
-- Balance follows the same split under usd_credit_sandbox. The old '<subject>:<project>' owner format is gone
-- (nothing was in production), so a personal hold has no project_id and a project hold spends the project's
-- account. A hold's subject may now be an app acting for a project, so its type is stored beside its id.

ALTER TABLE credit_holds ADD COLUMN subject_type text COLLATE "C" NOT NULL DEFAULT 'user'
    CHECK (subject_type IN ('user', 'app'));
ALTER TABLE credit_holds ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE credit_settlements ADD COLUMN subject_type text COLLATE "C" NOT NULL DEFAULT 'user'
    CHECK (subject_type IN ('user', 'app'));
ALTER TABLE credit_settlements ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE credit_sandbox_grants ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE credit_topup_debts ALTER COLUMN project_id DROP NOT NULL;

-- A move from a person's Balance to a project's Balance: one balanced journal transaction, recorded here so the
-- idempotency key names one transfer and a replay can answer with the same result.
CREATE TABLE balance_transfers (
    id text COLLATE "C" PRIMARY KEY,
    idempotency_key text COLLATE "C" NOT NULL UNIQUE,
    subject text COLLATE "C" NOT NULL,
    to_project_id text COLLATE "C" NOT NULL,
    amount_nano_usd bigint NOT NULL CHECK (amount_nano_usd > 0),
    journal_id text COLLATE "C" NOT NULL REFERENCES transactions (id),
    created_at timestamptz NOT NULL
);
CREATE INDEX balance_transfers_subject ON balance_transfers (subject, created_at);
CREATE INDEX balance_transfers_project ON balance_transfers (to_project_id, created_at);

-- Buying Vibes with Balance: the USD moves to platform_revenue in nano-USD and the Vibes are minted into the person's
-- Vibes account exactly as a pack purchase mints them. One row per purchase so the idempotency key is exact.
CREATE TABLE vibes_from_balance (
    id text COLLATE "C" PRIMARY KEY,
    idempotency_key text COLLATE "C" NOT NULL UNIQUE,
    subject text COLLATE "C" NOT NULL,
    vibes bigint NOT NULL CHECK (vibes > 0),
    price_nano_usd bigint NOT NULL CHECK (price_nano_usd > 0),
    bits_per_usd integer NOT NULL CHECK (bits_per_usd > 0),
    journal_id text COLLATE "C" NOT NULL REFERENCES transactions (id),
    created_at timestamptz NOT NULL
);
CREATE INDEX vibes_from_balance_subject ON vibes_from_balance (subject, created_at);

-- A Balance transfer is its own transaction type; it is not a provider receipt and never goes through chargeFor.
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('purchase', 'donation', 'subscription', 'subscription_share',
    'cashout_request', 'cashout_paid', 'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import', 'usage', 'credit',
    'balance_transfer')) NOT VALID;
ALTER TABLE transactions VALIDATE CONSTRAINT transactions_type_check;
