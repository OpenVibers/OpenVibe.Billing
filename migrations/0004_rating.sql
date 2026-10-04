-- phase: expand
-- Rating (plan T5 step 6): a stored usage reading becomes one `usage` transaction, user_credit:<subject> → platform_revenue
-- (vibes-bits), after the promo allowance (0003) has covered what it can; ops/rating.js, run by a background sweep that is
-- off by default. Nothing is charged without a rate card, and rate cards are loaded only by review
-- (scripts/load-rate-cards.js, platform.rate-card@1). Additive only: the one ALTER of an existing CHECK widens
-- transactions_type_check (the name PostgreSQL gave 0001's inline CHECK on transactions.type) by 'usage'; every other
-- change is a new table or a nullable column.

ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('purchase', 'donation', 'subscription', 'subscription_share',
    'cashout_request', 'cashout_paid', 'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import', 'usage'));

-- One provider price (platform.rate-card@1), as loaded; `card` is the card exactly as reviewed. A reading matches a card
-- when its provider and resource are the card's provider and metric, its region fits (a card without a region fits
-- every region) and its day is in [effective_from, effective_until).
CREATE TABLE rate_cards (
    id text COLLATE "C" PRIMARY KEY,
    provider text COLLATE "C" NOT NULL,
    metric text COLLATE "C" NOT NULL,
    region text COLLATE "C",
    unit_size numeric NOT NULL CHECK (unit_size > 0),
    unit_price_usd numeric NOT NULL CHECK (unit_price_usd >= 0),
    free_allowance numeric NOT NULL DEFAULT 0 CHECK (free_allowance >= 0),
    reset_period text COLLATE "C" NOT NULL CHECK (reset_period IN ('day', 'month', 'none')),
    effective_from date NOT NULL,
    effective_until date CHECK (effective_until > effective_from),
    source text COLLATE "C" NOT NULL,
    verified_at date NOT NULL,
    card jsonb NOT NULL,
    loaded_at timestamptz NOT NULL
);
CREATE INDEX rate_cards_lookup ON rate_cards (provider, metric, effective_from DESC);

-- Hard budgets: the most a subject's readings of one service ('*' = every service) may draw from their Vibes in one
-- window. A charge that would take spent_bits past budget_bits is refused whole; spent_bits moves in the transaction
-- that posts the charge. A subject + service without a row is limited only by their spendable balance.
CREATE TABLE usage_budgets (
    subject text COLLATE "C" NOT NULL,
    service text COLLATE "C" NOT NULL,
    reset_period text COLLATE "C" NOT NULL CHECK (reset_period IN ('day', 'month', 'none')),
    budget_bits bigint NOT NULL CHECK (budget_bits >= 0),
    spent_bits bigint NOT NULL DEFAULT 0 CHECK (spent_bits >= 0),
    window_start timestamptz NOT NULL,
    window_end timestamptz NOT NULL CHECK (window_end > window_start),
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (subject, service, window_start)
);

-- A reading's rating. rated_at/txn_id/vibes_charged are set together once it is charged (vibes_charged absent = not
-- rated yet); promo_bits is the allowance it consumed and free_allowance_used the part of `quantity` that covered, in
-- the reading's own unit. rating_error says why it is not rated yet; rating_due_at is when the sweep may try it (NULL:
-- never by itself — rated, not chargeable, or waiting for a rate card, which loading a matching card re-arms). The
-- constant default makes every reading, stored before or after this migration, due at once (no table rewrite).
ALTER TABLE usage_records
    ADD COLUMN rated_at timestamptz,
    ADD COLUMN txn_id text COLLATE "C" REFERENCES transactions (id),
    ADD COLUMN promo_bits bigint CHECK (promo_bits >= 0),
    ADD COLUMN free_allowance_used numeric CHECK (free_allowance_used >= 0),
    ADD COLUMN vibes_charged bigint CHECK (vibes_charged >= 0),
    ADD COLUMN rating_error text COLLATE "C",
    ADD COLUMN rating_due_at timestamptz DEFAULT 'epoch';

CREATE INDEX usage_records_rating_due ON usage_records (at, id) WHERE rating_due_at IS NOT NULL;
