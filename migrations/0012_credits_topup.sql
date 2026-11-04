-- phase: expand
-- Credits top-up (D9): a person pays through the existing checkout provider, the paid webhook credits their
-- (subject, project_id) usd_credit account with the allowed amount in nano-USD, and the fee the owner set goes to
-- platform_revenue. Everything is behind BILLING_CREDITS_TOPUP and the owner's amounts/fee configuration.
--
-- A refund or chargeback debits the account by what remains (never below zero). The part already spent is a debt of
-- the person, never written off: one row here per reversal, listed by reconciliation. The debt also has its own
-- ledger account kind so the reversal transaction balances (credit_topup_debt: negative = owed to the platform).

ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('user_credit', 'creator_payable', 'provider_clearing', 'platform_revenue', 'payouts_pending',
    'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion', 'promo_credit', 'promo_reserve', 'usd_credit', 'usd_credit_sandbox',
    'credit_topup_debt')) NOT VALID;
ALTER TABLE accounts VALIDATE CONSTRAINT accounts_kind_check;

-- A top-up is its own checkout intent kind: it is created by the person's Credits route, never by /api/v1, and its
-- paid webhook credits usd_credit instead of Vibes.
ALTER TABLE payment_intents DROP CONSTRAINT payment_intents_kind_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_kind_check CHECK (kind IN ('purchase', 'subscription', 'credits_topup')) NOT VALID;
ALTER TABLE payment_intents VALIDATE CONSTRAINT payment_intents_kind_check;

CREATE TABLE credit_topup_debts (
    id text COLLATE "C" PRIMARY KEY,
    topup_txn_id text COLLATE "C" NOT NULL REFERENCES transactions (id),
    transaction_id text COLLATE "C" NOT NULL UNIQUE REFERENCES transactions (id),   -- the refund/chargeback that left the debt
    reversal_ref text COLLATE "C" NOT NULL,
    subject text COLLATE "C" NOT NULL,
    project_id text COLLATE "C" NOT NULL,
    provider text COLLATE "C" NOT NULL,
    amount_nano_usd bigint NOT NULL CHECK (amount_nano_usd > 0),   -- the spent part of the top-up that was refunded
    reason text COLLATE "C" NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL
);
CREATE INDEX credit_topup_debts_subject ON credit_topup_debts (subject, project_id);
