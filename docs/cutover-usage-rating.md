# Cutover runbook — usage rating (OpenVibe.Billing, plan T5 step 6)

This change rates stored usage readings into the ledger: a background sweep (`server/ops/rating.js`) turns each
reading into at most one `usage` transaction, `user_credit:<subject>` → `platform_revenue` (vibes-bits), after the
promo allowance (step 5) has covered what it can, under hard budgets. **Both gates ship closed:** the sweep is off
(`BILLING_RATING_INTERVAL_MS` defaults to `0`) and no rate card is loaded (cards come only from
`scripts/load-rate-cards.js` with a reviewed `OV_RATE_CARDS`), so **the deploy charges nothing**. New routes
(`billing.ledger.admin`): `POST /api/v1/admin/rate`, `GET|POST /api/v1/admin/budgets`. No provider webhook, auth,
capability, Contracts or importer change.

## What the migration does

`migrations/0004_rating.sql` (`phase: expand`), in one transaction — additive only:

```sql
ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('purchase', 'donation', 'subscription', 'subscription_share',
    'cashout_request', 'cashout_paid', 'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import', 'usage'));
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
ALTER TABLE usage_records
    ADD COLUMN rated_at timestamptz,
    ADD COLUMN txn_id text COLLATE "C" REFERENCES transactions (id),
    ADD COLUMN promo_bits bigint CHECK (promo_bits >= 0),
    ADD COLUMN free_allowance_used numeric CHECK (free_allowance_used >= 0),
    ADD COLUMN vibes_charged bigint CHECK (vibes_charged >= 0),
    ADD COLUMN rating_error text COLLATE "C",
    ADD COLUMN rating_due_at timestamptz DEFAULT 'epoch';
CREATE INDEX usage_records_rating_due ON usage_records (at, id) WHERE rating_due_at IS NOT NULL;
```

`transactions_type_check` is the name PostgreSQL gave 0001's inline CHECK on `transactions.type` (checked on a
scratch database: `SELECT conname FROM pg_constraint WHERE conrelid = 'transactions'::regclass AND contype = 'c'`);
the new CHECK is the old list plus `usage`, so every existing row satisfies it and the `ADD CONSTRAINT` validation
scan only reads `transactions` (a few hundred rows in production). The new `usage_records` columns are nullable or
carry a constant default (`rating_due_at` = `'epoch'`), so PostgreSQL adds them without rewriting the table; the
`txn_id` foreign key is validated over an all-NULL column. `rate_cards` and `usage_budgets` start empty.

Every reading already stored (PR #6) becomes **due** (`rating_due_at` = epoch) but is charged only once the sweep
is switched on *and* a card matching its provider and resource is loaded; without a card it is marked
`billing.no_rate_card` and waits.

## What is not changed

- No ledger row (`transactions`, `ledger_entries`, `account_balances`) and no promo allowance is written, updated
  or deleted by the migration or the deploy.
- No existing column, index, trigger or account kind changes (`accounts_kind_check` is untouched).
- `POST /api/v1/usage` still only stores: it never charges.

## Prerequisites

1. **Snapshot the ledger:** `sudo ovhost backup --all --logical`; note the stamp
   (`/var/backups/openvibe/billing/<stamp>/billing.dump`).
2. **Confirm the unit is healthy:** `sudo systemctl status openvibe-billing` is active (running) and
   `/api/ready` returns 200 with `db: "ok"`.
3. **Confirm no freeze in flight:** `node scripts/freeze.js status` (from `/opt/openvibe.billing`) returns
   `"on": false`.
4. **Confirm the gates are closed in `/etc/openvibe/billing.env`:** no `BILLING_RATING_INTERVAL_MS` (or `0`), and
   no `OV_RATE_CARDS` unless a reviewed card file is intended for a later, separate step.

## Rehearsal

`ov rehearse` builds the base from main's migrations (0001–0003), loads the PostgreSQL seed below (a purchase, a tip,
their accounts and balances, one stored usage reading and one promo allowance), applies 0004, runs the migrations a
second time (nothing must apply), then the check: the widened CHECK holds `usage`, the five balances, two
transactions, six entries and the allowance are exactly as seeded, the stored reading is unrated and due, and
`rate_cards` and `usage_budgets` are empty.

```rehearse
seed: test/fixtures/usage-rating-seed.sql
node -e 'const a=require("assert"),{createDb}=require("openvibe-sdk/db");const db=createDb({url:process.env.DATABASE_DIRECT_URL,service:"rehearsal",max:1});(async()=>{const c=await db.prepare("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ?::regclass AND conname = ?").get("transactions","transactions_type_check");for(const k of ["purchase","donation","import","usage"])a.ok(c.d.includes(k),k);const b=await db.prepare("SELECT a.kind, a.owner_subject AS owner, b.balance FROM accounts a JOIN account_balances b ON b.account_id = a.id ORDER BY a.id").all();a.deepStrictEqual(b.map((r)=>[r.kind,r.owner,Number(r.balance)]),[["provider_clearing","powerchat",-1000],["fx_conversion",null,1000],["fx_conversion",null,-1000],["user_credit","usr_01JAB2C3D4E5F6G7H8J9K0SEED",600],["creator_payable","usr_01JAB2C3D4E5F6G7H8J9K0SEEE",400]]);a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).n),6);a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).n),2);const p=await db.prepare("SELECT granted_bits, used_bits FROM promo_allowances").all();a.deepStrictEqual(p.map((r)=>[Number(r.granted_bits),Number(r.used_bits)]),[[100,0]]);const u=await db.prepare("SELECT rated_at, txn_id, vibes_charged, promo_bits, free_allowance_used, rating_error, rating_due_at FROM usage_records").all();a.strictEqual(u.length,1);a.deepStrictEqual([u[0].rated_at,u[0].txn_id,u[0].vibes_charged,u[0].promo_bits,u[0].free_allowance_used,u[0].rating_error],[null,null,null,null,null,null]);a.strictEqual(new Date(u[0].rating_due_at).getTime(),0);for(const t of ["rate_cards","usage_budgets"])a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM "+t).get()).n),0,t);console.log("0004: transactions_type_check widened by usage, 5 balances, 2 transactions, 6 entries and the allowance unchanged, the stored reading unrated and due, rate_cards and usage_budgets empty")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```

By hand on a restored snapshot (a scratch role, never production): run the migrations with `openDb` as in PR #6's
runbook, then

```sql
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'transactions'::regclass AND conname = 'transactions_type_check';
SELECT id, name, phase FROM ov_migrations WHERE id = '0004';   -- 0004 | rating | expand
SELECT COUNT(*) FROM rate_cards;                                -- 0
SELECT COUNT(*) FROM usage_records WHERE rated_at IS NOT NULL;  -- 0
```

and compare `node scripts/reconcile.js` before and after: the same account, transaction and entry counts, every
check ok.

## Cutover

1. **Merge the PR** once the rehearsal is green.
2. **Deploy:** `sudo ovhost deploy billing "usage rating — migration 0004 (sweep off, no rate cards)"`. No lockfile
   change. The boot applies `0004_rating.sql` once (`migrations: applied 0004_rating (expand, NNms)`).
3. **Verify on production:**
   - `/api/ready` is 200; `ov_migrations` has the `0004` row; `\d usage_records` lists the seven new columns.
   - The journal shows no `[Billing] rating:` line (the sweep is off); `SELECT COUNT(*) FROM transactions WHERE
     type = 'usage'` is 0.
   - `node scripts/reconcile.js` shows the same totals as before the deploy, every check ok.
4. **Switching rating on is a later, reviewed step, not part of this deploy:** a reviewed card file in
   `OV_RATE_CARDS` → `node scripts/load-rate-cards.js --dry-run`, then without `--dry-run`; optional budgets
   (`POST /api/v1/admin/budgets`); then `POST /api/v1/admin/rate` once (or set `BILLING_RATING_INTERVAL_MS` and
   restart) and reconcile.

## Rollback

- **No reading has been rated (the day of the merge).** `sudo ovhost rollback billing`, then, in one transaction:
  ```sql
  BEGIN;
  DROP INDEX usage_records_rating_due;
  ALTER TABLE usage_records DROP COLUMN rated_at, DROP COLUMN txn_id, DROP COLUMN promo_bits,
      DROP COLUMN free_allowance_used, DROP COLUMN vibes_charged, DROP COLUMN rating_error, DROP COLUMN rating_due_at;
  DROP TABLE usage_budgets;
  DROP TABLE rate_cards;
  ALTER TABLE transactions DROP CONSTRAINT transactions_type_check;
  ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('purchase', 'donation', 'subscription',
      'subscription_share', 'cashout_request', 'cashout_paid', 'cashout_denied', 'recycle', 'refund', 'chargeback', 'adjustment', 'import'));
  DELETE FROM ov_migrations WHERE id = '0004';
  COMMIT;
  ```
  Leaving them in place is also safe: the previous release never reads the new columns or tables and never
  writes a `usage` transaction.
- **Readings have been rated.** The journal is append-only: `usage` transactions cannot be deleted and the narrow
  CHECK cannot be restored over them. Stop rating first (unset `BILLING_RATING_INTERVAL_MS`, restart), then roll
  back the code only (`sudo ovhost rollback billing`); the previous release ignores the new columns and tables.
  A wrong charge is corrected with a reversing `POST /api/v1/admin/adjustments` (`platform_revenue` →
  `user_credit:<subject>`), never by editing rows; the snapshot is the last resort.
