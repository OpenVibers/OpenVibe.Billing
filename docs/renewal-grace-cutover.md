# Cutover runbook — renewal grace (OpenVibe.Billing, plan T5 step 11, s2)

A credit renewal the subscriber cannot pay used to end the subscription at once (`expired`, reason
`renewal_insufficient_credit`). With this change it can instead move to **`past_due`** for
`BILLING_RENEWAL_GRACE_DAYS` past the period end: the hourly sweep retries the same charge under the **same
idempotency key** until it is paid (`active` again, reason `renewed`, one charge, one creator share) or
`grace_until` passes (`expired`, reason `grace_ended`). **The grace ships off** (`BILLING_RENEWAL_GRACE_DAYS`
defaults to `0`), so the deploy changes no behavior: no row becomes `past_due` until the grace is turned on.

Also in this change, whatever the grace: the renewal key is `renew:<sub>:<period end>` as before, and becomes
`renew:<sub>:<period end>:<k>` only after `k` charges under that period's earlier keys were refunded or charged back
(a reversal that brings `current_period_end` back to a period already renewed once no longer replays the reversed
charge as a "renewal" with no money and no period). Existing keys and their replays are unchanged.

No new route, capability or provider change. Events: `billing.entitlement.changed` gains reasons
`renewal_failed` and `grace_ended`, `subscription.status` `past_due`, and top-level `grace_until` /
`renewal_period_end` — all in `openvibe-contracts` v0.94.2 (Contracts PR #31). `GET /api/v1/entitlements/…` and
the subscription reads carry `grace_until` (and `renewal_failed_at`, `renewal_attempts` on the subscription).

## What the migration does

`migrations/0005_renewal_grace.sql` (`phase: expand`), in one transaction — additive and idempotent:

```sql
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'past_due', 'canceled', 'expired'));
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_until text COLLATE "C";
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_failed_at text COLLATE "C";
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_attempts bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS subscriptions_due_idx ON subscriptions (status, current_period_end);
```

The CHECK only widens (every existing row passes); the columns are nullable or defaulted, so the old code runs
against the new schema unchanged.

## Order

1. **Contracts** — v0.94.2 (`past_due`, `renewal_failed`, `grace_ended`, `grace_until`) is released (s1).
2. **Billing, grace 0** — merge and deploy this change through its pipeline. Leave `BILLING_RENEWAL_GRACE_DAYS`
   unset (= 0). Check: the service starts (the migration ran), `GET /api/ready` is green, and
   `SELECT count(*) FROM subscriptions WHERE status = 'past_due'` is 0. Renewals behave as before.
3. **VIP consumes `past_due`** — VIP (plan s4) treats `subscription.status: past_due` as not entitled, reads
   `grace_until` for its "renew your membership" notice and records each period's charge. Do not go further until
   VIP with that change is deployed.
4. **Turn the grace on** — plan s5 sets the default to 3; on a host before that, set
   `BILLING_RENEWAL_GRACE_DAYS=3` in `/etc/openvibe/billing.env` and restart through the deploy pipeline. Check
   after the next sweep: the log line `subscription sweep: … past due …` and, for a failed renewal,
   `SELECT id, status, grace_until, renewal_attempts FROM subscriptions WHERE status = 'past_due'`.

## Rollback

- **Turn the grace off:** set `BILLING_RENEWAL_GRACE_DAYS=0` (or unset it) and restart. The next sweep retries each
  `past_due` subscription once more on its key — a subscriber who topped up renews, with one charge — and ends
  the rest (`expired`, reason `grace_ended`). Nothing else changes.
- **Roll the code back:** turn the grace off first and wait for one sweep, so no row is `past_due` (the old code
  neither renews nor ends a `past_due` row). Then deploy the previous release; **the migration stays**: never drop
  the columns or narrow the CHECK (old code ignores them).
- A renewal charged under a `…:<k>` key is an ordinary `subscription` transaction; rolling back does not touch it.
