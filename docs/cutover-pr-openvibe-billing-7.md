# Cutover runbook — PR #7 (OpenVibe.Billing promo/free-credit ledger)

PR #7 adds the promo ledger (plan T5 step 5): two account kinds, `promo_credit:<subject>` and
`promo_reserve` (both vibes-bits), one empty table, `promo_allowances`, one admin route
(`POST /api/v1/admin/promo/grant`, `billing.ledger.admin`) and a `promo_bits` field on
`GET /api/v1/balances/:subject`. **The only ALTER widens `accounts_kind_check`** to accept the two new
kinds; no ledger row moves, no balance changes, no existing table gains or loses a column. No provider
webhook, auth, capability or Contracts change. The importer (`server/importer/live.js`) is untouched.

## What the migration does

`migrations/0003_promo_ledger.sql` (`phase: expand`), in one transaction:

```sql
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('user_credit', 'creator_payable', 'provider_clearing',
    'platform_revenue', 'payouts_pending', 'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion', 'promo_credit', 'promo_reserve'));

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
```

`accounts_kind_check` is the name PostgreSQL gave 0001's inline CHECK on `accounts.kind`
(`SELECT conname FROM pg_constraint WHERE conrelid = 'accounts'::regclass`); the new CHECK is the old list
plus two values, so every existing row satisfies it and the `ADD CONSTRAINT` validation scan only reads
`accounts` (a few hundred rows in production: 322 imported transactions). The `ACCESS EXCLUSIVE` lock on
`accounts` is held for that scan only, inside the migration's transaction, before the service serves.

## What is not changed

- No ledger row (`transactions`, `ledger_entries`, `account_balances`) is written, updated or deleted.
- No existing column, index, trigger or transaction type changes (`transactions_type_check` is untouched;
  promo movements are `adjustment` transactions with `metadata.promo` = grant | consume | lapse).
- The importer still maps Live's `bonus` to `user_credit` (O1-owned; see the PR body).
- No `BILLING_AUTHORITY`, webhook, service-token, capability or Contracts change. Nothing calls the grant
  route on the day of the merge; rating (T5 step 6) is the first caller of `consume()`.

## Prerequisites

1. **Snapshot the ledger:** `sudo ovhost backup --all --logical`; note the stamp
   (`/var/backups/openvibe/billing/<stamp>/billing.dump`).
2. **Confirm the unit is healthy:** `sudo systemctl status openvibe-billing` is active (running) and
   `/api/ready` returns 200 with `db: "ok"`.
3. **Confirm no freeze in flight:** `node scripts/freeze.js state` (from `/opt/openvibe.billing`) returns
   `{"on": false}`.

## Rehearsal

`ov rehearse` builds the base from main's migrations (0001, 0002), loads the PostgreSQL seed below (a
purchase and a tip with their accounts and balances; not a SQLite fixture), applies 0003, runs the
migrations a second time (nothing must apply), then the check: the widened CHECK holds all eleven kinds,
the five seeded balances and six entries are exactly as seeded, and `promo_allowances` is empty.

```rehearse
seed: test/fixtures/promo-ledger-seed.sql
node -e 'const a=require("assert"),{createDb}=require("openvibe-sdk/db");const db=createDb({url:process.env.DATABASE_DIRECT_URL,service:"rehearsal",max:1});(async()=>{const c=await db.prepare("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?").get("accounts","accounts_kind_check");for(const k of ["user_credit","creator_payable","fx_conversion","promo_credit","promo_reserve"])a.ok(c.d.includes(k),k);const b=await db.prepare("SELECT a.kind, a.owner_subject AS owner, b.balance FROM accounts a JOIN account_balances b ON b.account_id = a.id ORDER BY a.id").all();a.deepStrictEqual(b.map((r)=>[r.kind,r.owner,Number(r.balance)]),[["provider_clearing","powerchat",-1000],["fx_conversion",null,1000],["fx_conversion",null,-1000],["user_credit","usr_01JAB2C3D4E5F6G7H8J9K0SEED",600],["creator_payable","usr_01JAB2C3D4E5F6G7H8J9K0SEEE",400]]);a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).n),6);a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM promo_allowances").get()).n),0);console.log("0003: accounts_kind_check widened, 5 balances and 6 entries unchanged, promo_allowances empty")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```

By hand on a restored snapshot (a scratch role, never production): run the migrations with
`openDb` as in PR #6's runbook, then

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'accounts'::regclass AND conname = 'accounts_kind_check';
SELECT id, name, phase FROM ov_migrations WHERE id = '0003';   -- 0003 | promo_ledger | expand
SELECT COUNT(*) FROM promo_allowances;                          -- 0
```

and compare `node scripts/reconcile.js` before and after: the same account, transaction and entry counts,
every check ok (the new `promo.isolated` check passes on a ledger with no promo rows).

## Cutover

1. **Merge the PR** once the rehearsal marker is `{"ok": true}`.
2. **Deploy:** `sudo ovhost deploy billing "promo ledger (PR #7) — migration 0003 widens accounts_kind_check"`.
   No lockfile change. The boot applies `0003_promo_ledger.sql` once
   (`migrations: applied 0003_promo_ledger (expand, NNms)`).
3. **Verify on production:**
   - `/api/ready` is 200; `ov_migrations` has the `0003` row; `\d promo_allowances` lists the table.
   - `GET /api/v1/balances/<subject>` answers with `promo_bits: 0` beside the unchanged `credit`/`payable`.
   - `node scripts/reconcile.js` shows the same totals as before the deploy, every check ok, `promo.isolated` included.

## Rollback

- **No grant has been made (the day of the merge).** `sudo ovhost rollback billing`, then restore the old
  CHECK and drop the empty table in one transaction:
  ```sql
  BEGIN;
  DROP TABLE promo_allowances;
  ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
  ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('user_credit', 'creator_payable', 'provider_clearing',
      'platform_revenue', 'payouts_pending', 'refunds', 'import_adjustment', 'chargeback_loss', 'fx_conversion'));
  DELETE FROM ov_migrations WHERE id = '0003';
  COMMIT;
  ```
  Leaving them in place is also safe: the previous release never writes a promo kind.
- **Grants have been made.** The journal is append-only: promo rows cannot be deleted and the narrow CHECK
  cannot be restored over them. Roll back the code only (`sudo ovhost rollback billing`); the previous
  release ignores `promo_credit`/`promo_reserve` (its balances route does not report them and no code path
  moves them), and the snapshot is the last resort.

## PR description

````
```cutover
{"runbook": "docs/cutover-pr-openvibe-billing-7.md", "rehearsal": "billing-promo-ledger-001"}
```
````
