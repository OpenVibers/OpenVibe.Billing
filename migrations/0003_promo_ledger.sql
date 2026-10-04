-- phase: expand
-- The promo/free-credit ledger (plan T5 step 5, ledger 2): a recurring service allowance that can never become creator
-- money. Two new account kinds: promo_credit:<subject> (vibes-bits) holds a person's unused allowance, and promo_reserve
-- (platform, vibes-bits) is the marketing reserve it is issued from and returns to when consumed or lapsed, so free
-- allowance never touches platform_revenue. transfers.create reads user_credit only and cashouts read creator_payable
-- only, so no code path moves a promo bit into MONEY. promo_allowances is the policy and window record; the promo_credit
-- balance is the authoritative remainder (ops/promo.js writes both in one transaction).
-- The only ALTER widens accounts_kind_check (the name PostgreSQL gave 0001's inline CHECK on accounts.kind): no row moves.

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('user_credit', 'creator_payable', 'provider_clearing',
    'platform_revenue', 'payouts_pending', 'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion', 'promo_credit', 'promo_reserve'));

-- One allowance per subject, service ('*' = any eligible service), period and window. used_bits were consumed;
-- expired_bits lapsed when the window ended (returned to promo_reserve).
CREATE TABLE promo_allowances (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    subject text COLLATE "C" NOT NULL,
    service text COLLATE "C" NOT NULL,
    reset_period text COLLATE "C" NOT NULL CHECK (reset_period IN ('day', 'month', 'none')),
    granted_bits bigint NOT NULL CHECK (granted_bits > 0),
    used_bits bigint NOT NULL DEFAULT 0 CHECK (used_bits >= 0),
    expired_bits bigint NOT NULL DEFAULT 0 CHECK (expired_bits >= 0),
    window_start timestamptz NOT NULL,
    window_end timestamptz NOT NULL CHECK (window_end > window_start),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (used_bits + expired_bits <= granted_bits),
    UNIQUE (subject, service, reset_period, window_start)
);

CREATE INDEX promo_allowances_open ON promo_allowances (subject, window_end) WHERE used_bits + expired_bits < granted_bits;
