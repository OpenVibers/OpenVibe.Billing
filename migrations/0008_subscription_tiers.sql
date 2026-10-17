-- phase: expand
-- Creator-priced subscription tiers (openvibe-contracts 0.201.0, billing.tier.manage; server/ops/tiers.js): the monthly
-- price of each tier a creator sells, set through the product that sells them (OpenVibe.VIP) and charged here (ADR-012:
-- Billing prices, products never do). Tier 1 without a row keeps BILLING_SUB_PRICE_CENTS, so nothing changes for a
-- creator who sets no tiers. `archived` stops new subscriptions to a tier; running ones renew at their own price_cents.
CREATE TABLE subscription_tiers (
    streamer text COLLATE "C" NOT NULL,
    tier integer NOT NULL CHECK (tier BETWEEN 1 AND 10),
    price_cents bigint NOT NULL CHECK (price_cents > 0),
    status text COLLATE "C" NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    updated_by text COLLATE "C",
    created_at text COLLATE "C" NOT NULL,
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (streamer, tier)
);
