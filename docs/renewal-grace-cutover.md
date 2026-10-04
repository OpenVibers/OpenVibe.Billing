# Cutover runbook — renewal grace (OpenVibe.Billing, plan T5 step 11, s2 + s5)

A credit renewal the subscriber cannot pay used to end the subscription at once (`expired`, reason
`renewal_insufficient_credit`). With this change it can instead move to **`past_due`** for
`BILLING_RENEWAL_GRACE_DAYS` past the period end: the hourly sweep retries the same charge under the **same
idempotency key** until it is paid (`active` again, reason `renewed`, one charge, one creator share) or
`grace_until` passes (`expired`, reason `grace_ended`). **The grace shipped off in s2** (`BILLING_RENEWAL_GRACE_DAYS`
defaulted to `0`, so that deploy changed no behavior); **s5 turns it on** — the default is now `3`, so a failed
renewal is `past_due` for three days, retried on the same key, and only then expires. Setting the env back to `0`
restores immediate expiry (see Rollback).

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

## Backup

Before the merge, take the ledger snapshot any data change requires (PR #6's rule):

```sh
sudo ovhost backup --all --logical
```

Note the stamp: the logical `pg_dump` lands at
`/var/backups/openvibe/billing/<stamp>/billing.dump` (`root:root`, 0600). Keep it until the deploy is verified;
it is the way back if the restore ever has to be used. Confirm it exists and is non-empty before deploying:

```sh
sudo ls -l /var/backups/openvibe/billing/<stamp>/billing.dump
```

## Rehearsal

The harness records `ov rehearse OpenVibe.Billing 12` itself. `seed: none` keeps the base empty of fixtures
(0005 needs no rows — it only widens a CHECK and adds columns), so the rehearsal builds main's migrations,
applies 0005, runs the migrations a second time (nothing must apply), then checks the widened CHECK, the three
new columns and the sweep index.

```rehearse
seed: none
node -e 'const a=require("assert"),{createDb}=require("openvibe-sdk/db");const db=createDb({url:process.env.DATABASE_DIRECT_URL,service:"rehearsal",max:1});(async()=>{const c=await db.prepare("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?").get("subscriptions","subscriptions_status_check");for(const k of ["active","past_due","canceled","expired"])a.ok(c.d.includes(k),k);const cols=await db.prepare("SELECT column_name AS n, is_nullable AS nullable, column_default AS def FROM information_schema.columns WHERE table_name = ?").all("subscriptions");const by=Object.fromEntries(cols.map((r)=>[r.n,r]));a.strictEqual(by.grace_until.nullable,"YES");a.strictEqual(by.renewal_failed_at.nullable,"YES");a.strictEqual(by.renewal_attempts.nullable,"NO");a.ok(String(by.renewal_attempts.def).includes("0"),by.renewal_attempts.def);const i=await db.prepare("SELECT indexname AS n FROM pg_indexes WHERE tablename = ? AND indexname = ?").get("subscriptions","subscriptions_due_idx");a.ok(i&&i.n,"subscriptions_due_idx");console.log("0005: subscriptions_status_check widened to past_due, grace_until/renewal_failed_at/renewal_attempts added, subscriptions_due_idx present")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```

By hand on the restored snapshot (a scratch role, never production), after
`pg_restore` into a throwaway database and running the migrations with `openDb` as in PR #6's
runbook:

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'subscriptions'::regclass AND conname = 'subscriptions_status_check';
SELECT id, name, phase FROM ov_migrations WHERE id = '0005';         -- 0005 | renewal_grace | expand
SELECT COUNT(*) FROM subscriptions WHERE status = 'past_due';        -- 0 before the flip; failed renewals list here after s5
```

and compare `node scripts/reconcile.js` before and after: the same account, transaction and entry counts, every
check ok.

## Verification

After the deploy, on production (read-only):

1. `/api/ready` returns 200 with `db: "ok"`; the boot log has the line
   `migrations: applied 0005_renewal_grace (expand, NNms)`; `ov_migrations` has the `0005` row.
2. `\d subscriptions` lists `grace_until`, `renewal_failed_at` (nullable text) and `renewal_attempts`
   (`bigint NOT NULL DEFAULT 0`), and `subscriptions_due_idx`.
3. `SELECT count(*) FROM subscriptions WHERE status = 'past_due'` — before s5 it is **0** (the grace is off,
   `BILLING_RENEWAL_GRACE_DAYS` unset or `0`, so an unpaid renewal still ends at once with
   `renewal_insufficient_credit`); after s5's flip it holds exactly the renewals inside their 3-day grace.
   The flip itself changes no row: a subscription only enters `past_due` when the sweep next tries and
   fails to renew its ended period. `SELECT id, status, grace_until, renewal_attempts FROM subscriptions
   WHERE status = 'past_due'` lists them.
4. `node scripts/reconcile.js` shows the same totals as before the deploy, every check ok.

## Order

1. **Contracts** — v0.94.2 (`past_due`, `renewal_failed`, `grace_ended`, `grace_until`) is released (s1).
2. **Backup** — the snapshot above, and confirm it.
3. **Billing, grace 0 (s2)** — merge and deploy this change through its pipeline. Before the s5 flip the env was
   left unset (then = 0). Verify with the checks above. Renewals behave as before.
4. **VIP consumes `past_due`** — VIP (plan s4) treats `subscription.status: past_due` as not entitled, reads
   `grace_until` for its "renew your membership" notice and records each period's charge. Do not go further until
   VIP with that change is deployed.
5. **Turn the grace on — done (plan s5)** — the default is now `3`. No env change is needed: with
   `BILLING_RENEWAL_GRACE_DAYS` unset in `/etc/openvibe/billing.env`, deploy this change through the pipeline
   (VIP s4, which reads `past_due` and `grace_until`, must already be deployed). Check after the next sweep: the
   log line `subscription sweep: … past due …` and, for a failed renewal,
   `SELECT id, status, grace_until, renewal_attempts FROM subscriptions WHERE status = 'past_due'`. A host that
   sets the env explicitly (e.g. `BILLING_RENEWAL_GRACE_DAYS=0`) keeps that value — remove it to take the default.

## Rollback

- **Turn the grace off:** set `BILLING_RENEWAL_GRACE_DAYS=0` in `/etc/openvibe/billing.env` and restart (do
  **not** merely unset it — unset now means the default 3). The next sweep retries each
  `past_due` subscription once more on its key — a subscriber who topped up renews, with one charge — and ends
  the rest (`expired`, reason `grace_ended`). Nothing else changes. This is the way back for behavior; no
  schema restore is needed.
- **Roll the code back:** turn the grace off first and wait for one sweep, so no row is `past_due` (the old code
  neither renews nor ends a `past_due` row). Then deploy the previous release (`sudo ovhost rollback billing`);
  **the migration stays**: never drop the columns or narrow the CHECK (old code ignores them).
- **Restore the snapshot (last resort):** stop the unit, `pg_restore` the `billing.dump` from the stamp above
  over `ov_billing`, then start the previous release. Only if the schema or data is actually wrong; the migrate is
  additive, so rollback without restore is the normal path.
- A renewal charged under a `…:<k>` key is an ordinary `subscription` transaction; rolling back does not touch it.
