-- phase: expand
-- The past_due state of the renewal grace (plan T5 step 11, s2; contracts 0.94.0's past_due on
-- billing.entitlement.changed). A credit renewal that fails (insufficient funds) may be retried until a
-- grace deadline instead of ending the subscription at once; the subscription is past_due for that window.
-- The only ALTER widens subscriptions_status_check (the name PostgreSQL gave 0001's inline CHECK on
-- subscriptions.status): no row moves, and the grace window is off unless BILLING_RENEWAL_GRACE_DAYS is set.

ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'past_due', 'canceled', 'expired'));
