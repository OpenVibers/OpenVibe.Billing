# Cutover runbook — PR #11 (OpenVibe.Billing opt-in past_due renewal grace)

PR #11 adds the past_due state of the renewal grace (plan T5 step 11, s2): the hourly subscription sweep may
retry a credit renewal it cannot cover until a grace deadline instead of expiring the subscription at once.
`migrations/0005_subscription_past_due.sql` (`phase: expand`) is the **only** schema change: it widens
`subscriptions_status_check` (the name PostgreSQL gave 0001's inline CHECK on `subscriptions.status`) to
accept `past_due`. No row moves, no column, index, other constraint or table changes; the grace is off
unless `BILLING_RENEWAL_GRACE_DAYS` is set (default `0`, today's immediate-expire behavior). The change
also adds `server/config.js`'s `renewalGraceDays`, the sweep selection of `past_due` in
`server/ops/subscriptions.js`, the sweep log line in `server/index.js`, the README note and
`test/subscriptions-grace.test.js`. No provider webhook, auth, capability or Contracts change.

## What the migration does

`migrations/0005_subscription_past_due.sql`, in one transaction:

```sql
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'past_due', 'canceled', 'expired'));
```

`subscriptions_status_check` is the name PostgreSQL gave 0001's inline CHECK on `subscriptions.status`. The
new CHECK is the old list plus one value, so every existing row satisfies it and the `ADD CONSTRAINT`
validation scan only reads `subscriptions` (small in production). The `ACCESS EXCLUSIVE` lock is held for
that scan only, inside the migration's transaction, before the service serves.

## What is not changed

- No `subscriptions`, `entitlements`, `transactions`, `ledger_entries` or `account_balances` row is written,
  updated or deleted by the migration; the sweep only runs once the service boots, an hour after deploy.
- No other column, index, trigger or constraint changes (`entitlements` is untouched).
- With `BILLING_RENEWAL_GRACE_DAYS` unset (default `0`) the sweep behaves exactly as before: a credit renewal
  it cannot cover expires the subscription at once (`renewal_insufficient_credit`); `past_due` is never
  written, so the widening is inert. No `BILLING_AUTHORITY`, webhook, service-token or capability change.

## Prerequisites

1. **Snapshot the ledger and subscriptions:** `sudo ovhost backup --all --logical`; note the stamp
   (`/var/backups/openvibe/billing/<stamp>/billing.dump`).
2. **Confirm the unit is healthy:** `sudo systemctl status openvibe-billing` is active (running) and
   `/api/ready` returns 200 with `db: "ok"`.
3. **Confirm no freeze in flight:** `node scripts/freeze.js state` (from `/opt/openvibe.billing`) returns
   `{"on": false}`.

## Rehearsal

`ov rehearse` builds the base from main's migrations (0001–0004), loads the PostgreSQL seed below (two
subscriptions: one active with `auto_renew` on, one canceled; not a SQLite fixture), applies 0005, runs the
migrations a second time (nothing must apply), then the check: the widened CHECK holds all four statuses,
both seeded rows are exactly as seeded, `0005` is recorded as `expand`, and a newly inserted `past_due` row
is accepted.

```rehearse
seed: test/fixtures/subscription-past-due-seed.sql
node -e 'const a=require("assert"),{createDb}=require("openvibe-sdk/db");const db=createDb({url:process.env.DATABASE_DIRECT_URL,service:"rehearsal",max:1});(async()=>{const c=await db.prepare("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?").get("subscriptions","subscriptions_status_check");for(const s of ["active","past_due","canceled","expired"])a.ok(c.d.includes(s),s);const rows=await db.prepare("SELECT id, status, auto_renew FROM subscriptions ORDER BY id").all();a.deepStrictEqual(rows.map((r)=>[r.id,r.status,Number(r.auto_renew)]),[["sub_01JAB2C3D4E5F6G7H8J9K0SEED1","active",1],["sub_01JAB2C3D4E5F6G7H8J9K0SEED2","canceled",0]]);const m=await db.prepare("SELECT id, name, phase FROM ov_migrations WHERE id = ?").get("0005");a.deepStrictEqual([m.id,m.name,m.phase],["0005","subscription_past_due","expand"]);await db.prepare("INSERT INTO subscriptions (id, subscriber, streamer, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("sub_01JAB2C3D4E5F6G7H8J9K0SEED3","usr_01JAB2C3D4E5F6G7H8J9K0SEEDG","usr_01JAB2C3D4E5F6G7H8J9K0SEEEE","powerchat","past_due","2026-10-04T00:00:00.000Z","2026-10-04T00:00:00.000Z");const p=await db.prepare("SELECT status FROM subscriptions WHERE id = ?").get("sub_01JAB2C3D4E5F6G7H8J9K0SEED3");a.strictEqual(p.status,"past_due");console.log("0005: subscriptions_status_check widened by past_due, 2 seeded subscriptions unchanged, a new past_due row accepted")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```

By hand on a restored snapshot (a scratch role, never production): run the migrations with `openDb` as in
PR #6's runbook, then

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'subscriptions'::regclass AND conname = 'subscriptions_status_check';
SELECT id, name, phase FROM ov_migrations WHERE id = '0005';   -- 0005 | subscription_past_due | expand
SELECT status, COUNT(*) FROM subscriptions GROUP BY status;     -- same counts as before the migration
```

and compare `node scripts/reconcile.js` before and after: the same account, transaction and entry counts,
every check ok.

## Cutover

1. **Merge the PR** once the rehearsal marker is `{"ok": true}`.
2. **Deploy:** `sudo ovhost deploy billing "past_due renewal grace (PR #11) — migration 0005 widens subscriptions_status_check"`.
   No lockfile change. The boot applies `0005_subscription_past_due.sql` once
   (`migrations: applied 0005_subscription_past_due (expand, NNms)`).
3. **Verify on production:**
   - `/api/ready` is 200; `ov_migrations` has the `0005` row; the constraint def lists `past_due`.
   - `SELECT status, COUNT(*) FROM subscriptions GROUP BY status` is identical to before the deploy.
   - `node scripts/reconcile.js` shows the same totals as before the deploy, every check ok.
4. **Enable the grace (optional, separate from this PR's deploy):** set `BILLING_RENEWAL_GRACE_DAYS` (e.g. `3`)
   in `/etc/openvibe/billing.env` and restart. With it unset the grace stays off and nothing changes.

## Rollback

- **Grace never enabled (the day of the merge; default).** No `past_due` row exists, so the widening can be
  undone: `sudo ovhost rollback billing`, then restore the old CHECK and drop the migration row in one
  transaction:
  ```sql
  BEGIN;
  ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
  ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('active', 'canceled', 'expired'));
  DELETE FROM ov_migrations WHERE id = '0005';
  COMMIT;
  ```
  Leaving them in place is also safe: the previous release never writes `past_due` and ignores the wider CHECK.
- **Grace enabled and a subscription is `past_due`.** The narrow CHECK cannot be restored over it. Roll the
  code back only (`sudo ovhost rollback billing`); the previous release expires any `past_due` subscription on
  its next sweep because its sweep does not select that status — no entitlement is lost, only the grace
  deadline is. The snapshot from Prerequisites is the last resort.

## PR description

````
```cutover
{"runbook": "docs/cutover-pr-openvibe-billing-11.md", "rehearsal": "billing-past-due-grace-001"}
```
````
