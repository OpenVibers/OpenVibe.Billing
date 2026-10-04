-- phase: expand
-- Renewal grace (plan T5 step 11, s2): a credit renewal the subscriber cannot pay moves the subscription to `past_due`
-- until grace_until, and the renewal sweep retries the charge under the SAME idempotency key until it is paid
-- (active again) or grace_until passes (expired, reason grace_ended). Off by default: BILLING_RENEWAL_GRACE_DAYS=0
-- keeps the old behavior (expire at once, reason renewal_insufficient_credit), so no row becomes past_due until the
-- grace is turned on. Additive and idempotent: the one ALTER of an existing CHECK widens subscriptions_status_check
-- (the name PostgreSQL gave 0001's inline CHECK on subscriptions.status) by 'past_due'; the rest are new columns, two
-- nullable and one with a default. Rollback is BILLING_RENEWAL_GRACE_DAYS=0 (the sweep expires the past_due rows);
-- the columns and the widened CHECK stay (docs/renewal-grace-cutover.md).

ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'past_due', 'canceled', 'expired'));

-- past_due only: when the sweep stops retrying and ends the subscription (the failed period's end + the grace days).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_until text COLLATE "C";
-- The last failed renewal charge, and how many failed for the current period (both reset by a paid period).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_failed_at text COLLATE "C";
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_attempts bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS subscriptions_due_idx ON subscriptions (status, current_period_end);
