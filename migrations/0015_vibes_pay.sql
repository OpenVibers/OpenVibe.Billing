-- phase: expand
-- Vibes Pay (D12 step 4): a developer app creates a charge, a person pays it on OpenVibe's pay sheet, and the
-- Vibes move once from the person to the app's project. Amounts are whole Vibes (bigint, never a fraction).
--
--   vibes_charges        one row per charge; (app_id, reference) is the app's idempotency key
--   vibes_payers         the opaque payer_ref of a person, stable per app (never a person id in a webhook)
--   vibes_webhook_outbox durable signed deliveries, retried with backoff
--
-- The project's Vibes wallet is a new account kind (project_payable), and sandbox pay uses its own kinds and
-- test transactions, so a sandbox charge can never touch real Vibes. A project cashout spends project_payable
-- through the existing cashout path (POST /api/v1/cashouts with project_id), checked against Network's owner role.

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('user_credit', 'creator_payable', 'provider_clearing', 'platform_revenue', 'payouts_pending',
    'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion', 'promo_credit', 'promo_reserve', 'usd_credit', 'usd_credit_sandbox',
    'credit_topup_debt', 'project_payable', 'vibes_credit_sandbox', 'project_payable_sandbox', 'vibes_sandbox')) NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT accounts_kind_check;

ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('purchase', 'donation', 'subscription', 'subscription_share',
    'cashout_request', 'cashout_paid', 'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import', 'usage', 'credit',
    'balance_transfer', 'vibes_charge', 'vibes_refund', 'vibes_sandbox_grant')) NOT VALID;
ALTER TABLE transactions VALIDATE CONSTRAINT transactions_type_check;

-- A project's received Vibes are cashed out by its owner; record which project a cashout belongs to.
ALTER TABLE cashouts ADD COLUMN project_id text COLLATE "C";

CREATE TABLE vibes_charges (
    id text COLLATE "C" PRIMARY KEY,
    app_id text COLLATE "C" NOT NULL,
    project_id text COLLATE "C" NOT NULL,
    amount bigint NOT NULL CHECK (amount > 0),
    description text COLLATE "C" NOT NULL,
    reference text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL CHECK (status IN ('pending', 'paid', 'refunded', 'expired', 'cancelled')),
    pay_url text COLLATE "C" NOT NULL,
    return_url text COLLATE "C",
    sandbox bigint NOT NULL DEFAULT 0 CHECK (sandbox IN (0, 1)),
    payer_subject text COLLATE "C",
    payer_ref text COLLATE "C",
    pay_idempotency_key text COLLATE "C",
    refund_reason text COLLATE "C",
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    paid_at timestamptz,
    refunded_at timestamptz,
    cancelled_at timestamptz,
    UNIQUE (app_id, reference)
);
CREATE INDEX vibes_charges_app_status ON vibes_charges (app_id, status, created_at);
CREATE INDEX vibes_charges_payer ON vibes_charges (payer_subject, paid_at) WHERE payer_subject IS NOT NULL;

-- payer_ref is opaque and stable per app: the webhook carries it instead of a person id or email. A random value,
-- never a hash of the subject (a dump of this table plus a guessable subject space must not link the two).
CREATE TABLE vibes_payers (
    app_id text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    payer_ref text COLLATE "C" NOT NULL UNIQUE,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (app_id, subject)
);

CREATE TABLE vibes_webhook_outbox (
    id text COLLATE "C" PRIMARY KEY,
    charge_id text COLLATE "C" NOT NULL REFERENCES vibes_charges (id),
    app_id text COLLATE "C" NOT NULL,
    event_type text COLLATE "C" NOT NULL CHECK (event_type IN ('billing.vibes.charge.paid', 'billing.vibes.charge.refunded')),
    payload text COLLATE "C" NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL,
    delivered_at timestamptz,
    abandoned_at timestamptz,
    last_status integer,
    last_error text COLLATE "C",
    created_at timestamptz NOT NULL
);
CREATE INDEX vibes_webhook_due ON vibes_webhook_outbox (next_attempt_at, id)
    WHERE delivered_at IS NULL AND abandoned_at IS NULL;
