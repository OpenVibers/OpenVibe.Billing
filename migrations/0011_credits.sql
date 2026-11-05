-- phase: expand
-- Credits: the prepaid USD balance for metered services (AI Exchange D1, D2): per-(subject, project_id) nano-USD accounts,
-- reservation holds, final settlements and sandbox grants. Integer nano-USD (1e-9 USD) stored as BIGINT,
-- computed with BigInt arithmetic in JS. Nothing here touches chargeFor, Vibes bits, creator payables,
-- cashout or promo. The subledger is off until BILLING_CREDITS=1; sandbox grants need
-- BILLING_CREDITS_SANDBOX=1.

-- Widen the existing account-kind and currency enumerations. The (kind, owner_subject, currency) unique
-- key stays; inference accounts use kind='usd_credit', currency='nano-usd' and owner_subject
-- '<subject>:<project_id>' so the ledger remains balanced without a second journal.
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('user_credit', 'creator_payable', 'provider_clearing', 'platform_revenue', 'payouts_pending',
    'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion', 'promo_credit', 'promo_reserve', 'usd_credit', 'usd_credit_sandbox')) NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT accounts_kind_check;
ALTER TABLE accounts DROP CONSTRAINT accounts_currency_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_currency_check CHECK (currency IN ('vibes-bits', 'usd-cents', 'nano-usd')) NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT accounts_currency_check;

-- Inference charges are a distinct transaction type. They never go through 'usage' or chargeFor.
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('purchase', 'donation', 'subscription', 'subscription_share',
    'cashout_request', 'cashout_paid', 'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import', 'usage', 'credit')) NOT VALID;
ALTER TABLE transactions VALIDATE CONSTRAINT transactions_type_check;

-- Holds: an active reservation against an inference account. held_nano_usd reduces the available balance
-- while the hold is active. The hold is created, extended, settled or released exactly once.
CREATE TABLE credit_holds (
    id text COLLATE "C" PRIMARY KEY,
    idempotency_key text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    project_id text COLLATE "C" NOT NULL,
    credential_id text COLLATE "C",
    service text COLLATE "C" NOT NULL DEFAULT 'ai' CHECK (service ~ '^[a-z][a-z0-9-]{0,39}$'),   -- which metered service spends it (ai, run, ...)
    account_id bigint NOT NULL REFERENCES accounts (id),
    held_nano_usd bigint NOT NULL CHECK (held_nano_usd >= 0),
    max_nano_usd bigint NOT NULL CHECK (max_nano_usd >= 0),
    rate_version text COLLATE "C" NOT NULL,
    request_fingerprint text COLLATE "C" NOT NULL,
    lease_expires_at timestamptz NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'extended', 'settled', 'released', 'expired')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (idempotency_key)
);
CREATE INDEX credit_holds_account_active ON credit_holds (account_id, status) WHERE status IN ('active', 'extended');
CREATE INDEX credit_holds_lease ON credit_holds (lease_expires_at) WHERE status IN ('active', 'extended');

-- Settlements: the final charge for one hold. The retail rate version and usage are kept exactly as
-- supplied so the charge is reproducible. supply_cost_nano_usd is recorded for margin analytics; it is
-- not a ledger movement until a supplier is actually paid.
CREATE TABLE credit_settlements (
    id text COLLATE "C" PRIMARY KEY,
    hold_id text COLLATE "C" NOT NULL UNIQUE REFERENCES credit_holds (id),
    idempotency_key text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    project_id text COLLATE "C" NOT NULL,
    account_id bigint NOT NULL REFERENCES accounts (id),
    charge_nano_usd bigint NOT NULL CHECK (charge_nano_usd >= 0),
    released_nano_usd bigint NOT NULL CHECK (released_nano_usd >= 0),
    shortfall_nano_usd bigint NOT NULL DEFAULT 0 CHECK (shortfall_nano_usd >= 0),   -- usage beyond hold + balance: owed, not collected
    journal_id text COLLATE "C" NOT NULL REFERENCES transactions (id),
    usage jsonb NOT NULL,
    retail jsonb NOT NULL,
    supply_cost_nano_usd bigint NOT NULL CHECK (supply_cost_nano_usd >= 0),
    byok boolean NOT NULL DEFAULT false,
    attempts jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL,
    UNIQUE (idempotency_key)
);
CREATE INDEX credit_settlements_account ON credit_settlements (account_id);

-- Sandbox grants: synthetic inference credit, available only when BILLING_CREDITS_SANDBOX=1.
-- Each grant is one inference transaction usd_credit_sandbox -> usd_credit, marked test.
CREATE TABLE credit_sandbox_grants (
    id text COLLATE "C" PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    project_id text COLLATE "C" NOT NULL,
    account_id bigint NOT NULL REFERENCES accounts (id),
    amount_nano_usd bigint NOT NULL CHECK (amount_nano_usd > 0),
    journal_id text COLLATE "C" NOT NULL REFERENCES transactions (id),
    reason text COLLATE "C" NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL
);
