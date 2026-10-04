# Cutover runbook — PR #6 (OpenVibe.Billing usage readings)

PR #6 adds one empty table, `usage_records`, with four indexes, and two HTTP routes:
`POST /api/v1/usage` (idempotent by the reading's own `idempotency_key`) and
`GET /api/v1/usage` (filters by project, subject, service and `[from, to)`,
cursor paging). Nothing existing is renamed, dropped or altered; no ledger column is
the result of this PR; no provider webhook changes; no auth changes. Reads of
`usage_records` are not a money movement.

## What the migration does

`migrations/0002_usage.sql` (`phase: expand`) creates the new table only:

```sql
CREATE TABLE usage_records (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key text COLLATE "C" NOT NULL UNIQUE,
    project text COLLATE "C",
    subject text COLLATE "C",
    service text COLLATE "C" NOT NULL,
    at timestamptz NOT NULL,
    reading jsonb NOT NULL,
    reading_hash text COLLATE "C" NOT NULL,
    principal text COLLATE "C" NOT NULL,
    received_at timestamptz NOT NULL
);
CREATE INDEX usage_records_at       ON usage_records (at, id);
CREATE INDEX usage_records_project  ON usage_records (project, at, id) WHERE project IS NOT NULL;
CREATE INDEX usage_records_subject  ON usage_records (subject, at, id) WHERE subject IS NOT NULL;
CREATE INDEX usage_records_service  ON usage_records (service, at, id);
```

The runner is `openvibe-sdk/db`'s `migrate()`: it locks `ov_migrations`, runs
the file inside one transaction (no `no-transaction` header is set, so it is
transactional), records the sha256 of the file's content, and refuses any
later edit of an applied migration. No `ov_migrations` row exists yet for
`0002_usage.sql` on the current production ledger; the runner will add one.

## What is not changed

- No existing table is renamed, dropped or altered. The migration is additive.
- No index on an existing table is created, dropped or rebuilt.
- No money-bearing column, account kind, transaction type or ledger enum moves.
- No provider webhook URL moves (the PowerChat webhook, the cutover's step 6,
  is a separate change governed by `docs/live-cutover.md`; this PR is independent).
- No `BILLING_AUTHORITY` change. The cutover's switch flips in another runbook.
- No service-token, capability or grant change. `billing.usage.record` is
  declared in `docs/capabilities-proposal/billing.usage.record.json` but is not
  yet in OpenVibe.Contracts' released capability manifests (v0.84.0); until
  Contracts releases it, the route is reachable only to service tokens the
  operator grants by hand (none today). No call site anywhere in the network
  POSTs to `/api/v1/usage` on the day of this PR's merge.

## Prerequisites

1. **Snapshot the ledger.** The new migration only adds an empty table, but
   the pre-merge rule for any data change is a snapshot the operator can roll
   back to. Force the weekly logical dump for the Billing database
   (`pg_dump -Fc` lives at `/var/backups/openvibe/billing/<stamp>/billing.dump`,
   owned `root:root`, 0600; `OpenVibe.Host/docs/backups.md:108-113`):
   ```bash
   sudo ovhost backup --all --logical
   ```
   The recipe verifies `pg_stat_archiver.failed_count` has not increased,
   reads the per-service row counts and writes the dump. Note the stamp
   printed at the end of the run; the rollback section uses it.
2. **Confirm the unit is healthy.** `sudo systemctl status openvibe-billing`
   answers active (running) and `/api/ready` returns 200 with `db: "ok"`.
3. **Confirm no freeze in flight.** `node scripts/freeze.js state` (run from
   `/opt/openvibe.billing`) returns `{"on": false}`. If it is on, find and
   resolve the freeze first; this PR does not interact with the freeze but the
   snapshot step must be taken when writes are healthy.

## Rehearsal on a snapshot

Run this on a copy of the production data, **never on the production ledger**;
the rehearsal is green when `ds/deploy/rehearsals/billing-usage-records-001.json`
on the harness says `{"ok": true}`. This section is the rehearsal.

1. Restore the snapshot taken in prerequisites into a scratch database role
   the operator stands up for the rehearsal (a separate Postgres role on the
   same cluster, isolated from `ov_billing`). `openvibe-sdk/db`'s `migrate()`
   is idempotent across roles; the rehearsal role has its own `ov_migrations`.
2. Run the migration runner against the rehearsal role, with the same
   `migrations/` directory the deployed release ships:
   ```bash
   DATABASE_URL=<rehearsal-url> DATABASE_DIRECT_URL=<rehearsal-direct-url> \
     node -e 'const { openDb } = require("./server/db"); openDb({ db: { url: process.env.DATABASE_URL, directUrl: process.env.DATABASE_DIRECT_URL }, isProduction: false, log: { info: console.log, warn: console.warn, error: console.error } }).then((db) => db.close())'
   ```
   The runner is silent on a clean ledger; a successful run adds one row to
   `ov_migrations` with `id = '0002'`, `name = 'usage'`, `phase = 'expand'`.
3. Verify the schema is exactly what the PR added:
   ```sql
   \d usage_records
   SELECT indexname FROM pg_indexes WHERE tablename = 'usage_records' ORDER BY indexname;
   SELECT id, name, phase FROM ov_migrations WHERE id = '0002';
   ```
   The table has the nine columns listed above; `usage_records.id` is a
   `bigint GENERATED ALWAYS AS IDENTITY`; the four indexes are present;
   `ov_migrations` has one row for `0002_usage`.
4. Boot the rehearsal instance against the rehearsal database:
   `NODE_ENV=production PORT=4601 DATABASE_URL=<rehearsal-url>
   DATABASE_DIRECT_URL=<rehearsal-direct-url> node server/index.js`.
   `/api/ready` returns 200; the boot log prints `migrations: applied 0002_usage
   (expand, NNms)` once and not again on a second boot (the checksum is
   recorded).
5. Run the focused suite on the rehearsal instance:
   `ov test test/usage.test.js test/dependency-pins.test.js`. Both pass.
   No existing test regresses (`test/usage.test.js` is the only test the PR
   adds; `test/dependency-pins.test.js` is the README-pin guard the PR also
   adds).
6. Exercise the routes by hand:
   ```bash
   curl -sS -X POST http://127.0.0.1:4601/api/v1/usage \
     -H "Authorization: Bearer $BILLING_USAGE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"id":"use-rhb-1","idempotency_key":"rehearsal:0002:1","service":"media","operation":"deliver","quantity":1,"unit":"GiB","at":"2026-10-03T12:00:00Z","source":"rehearsal"}'
   ```
   A valid `platform.usage-sample@1` body returns 201 with `record` populated;
   the same body again returns 200 with `Idempotent-Replayed: true` and the
   stored row; a body with a different reading under the same key returns 409
   `billing.usage_key_reused`. `GET /api/v1/usage?project=...` lists the
   row newest-first. Reject 422 for an invalid reading; reject 401 without a
   token; reject 403 with a token that lacks `billing.usage.record`.
7. Write the green marker:
   ```bash
   mkdir -p ~/openvibe/agents/ds/deploy/rehearsals
   printf '{"ok": true}\n' > ~/openvibe/agents/ds/deploy/rehearsals/billing-usage-records-001.json
   ```
   The harness reads this file; the deploy is gated on `{"ok": true}`.

## Cutover

The merge is automated once the rehearsal is green. The deploy is the standard
`openvibe-billing` deploy:

1. **Merge the PR.** The PR description carries the cutover manifest below;
   the harness's `data` risk class waits for `ds/deploy/rehearsals/billing-usage-records-001.json`
   to be `{"ok": true}` before letting the deploy start.
2. **Deploy.** `sudo ovhost deploy billing "usage readings (PR #6) — additive
   migration 0002_usage"`. The `git-checkout` recipe fast-forwards
   `/opt/openvibe.billing`, installs on a lockfile change (this PR bumps
   `openvibe-contracts` v0.76.0 → v0.84.0 and `openvibe-shared` v2.3.1 →
   v2.5.0), restarts `openvibe-billing.service`, waits for `/api/ready`.
3. **The boot applies the migration.** The systemd unit runs `node
   server/index.js`; `server/db.js`'s `openDb` runs `owner.migrate({ dir:
   MIGRATIONS, log })` against `DATABASE_DIRECT_URL`. The runner takes the
   `ov_migrations` advisory lock, applies `0002_usage.sql` in one transaction,
   records the checksum, releases the lock. The journal line is
   `migrations: applied 0002_usage (expand, NNms)`. The boot then opens the
   PgBouncer-backed serving handle and the unit is healthy.
4. **Verify on production.**
   - `sudo ovhost access run openvibe-ovh show billing` reads clean: the unit
     is active (running), `/api/ready` is 200 with `db: "ok"`, the boot log
     mentions `0002_usage` exactly once.
   - `psql -d ov_billing -c '\d usage_records'` lists the nine columns and the
     four indexes; `ov_migrations` has the `0002_usage` row.
   - `curl -sS http://127.0.0.1:4600/api/v1/usage` with a token that has
     `billing.usage.record` returns `{ records: [], next_cursor: null }`.
   - `node scripts/reconcile.js` (run from `/opt/openvibe.billing`) prints
     `accounts: N, transactions: N, ledger_entries: N` with the same totals
     as before the deploy. Nothing money-bearing moved.

The cutover is done when step 4's four lines are clean.

## Rollback

Because the migration is additive and the table is empty on the day of the
merge, the rollback is one DDL away. Pick the path that matches the elapsed
time.

- **No usage row has been written yet (the common case the day of the merge).**
  Roll back the deploy and drop the empty table:
  1. `sudo ovhost rollback billing` — the recipe takes the unit to the
     previous release (`openvibe-contracts` v0.76.0, `openvibe-shared` v2.3.1,
     no `0002_usage.sql`). The previous release's boot refuses to apply a
     migration it does not know about (the file is absent) and the runner is
     silent on a ledger that already has the `ov_migrations` row from the bad
     release. The unit is healthy on the old code; `/api/ready` is 200.
  2. `psql -d ov_billing -c 'DROP INDEX IF EXISTS usage_records_at; DROP INDEX IF EXISTS usage_records_project; DROP INDEX IF EXISTS usage_records_subject; DROP INDEX IF EXISTS usage_records_service; DROP TABLE IF EXISTS usage_records; DELETE FROM ov_migrations WHERE id = '\''0002'\'';`
     The rollback unit can also run a `drover` step that wipes the table and
     the `ov_migrations` row in one transaction; either form is fine.
  3. Verify: `\d usage_records` says "Did not find any relation named
     'usage_records'"; `ov_migrations` has no `0002` row; `ov test
     test/usage.test.js` is skipped (the previous release has no usage
     code); the focused suite that *did* exist on the previous release
     passes.
- **Usage rows have been written since the merge.** A `DELETE FROM
  usage_records` is destructive (the readings are first-party service
  telemetry; nothing else references them in the journal). If a row was
  written, decide with the owner whether to keep the table (preferred: the
  rows are additive and the table does not block the rollback) or to wipe
  them. If the call is to wipe, run `DELETE FROM usage_records; DELETE FROM
  ov_migrations WHERE id = '0002';` in one transaction. The deploy rollback
  then completes as above. The snapshot taken before the merge
  (`/var/backups/openvibe/billing/<stamp>/billing.dump`) is the last resort
  if a partial state cannot be reasoned about; restore it into a scratch role,
  compare `usage_records` row counts, then act.
- **The deploy itself is broken on the new release.** `sudo ovhost rollback
  billing` takes the unit back to the previous release in one step; the
  migration runner refuses to run `0002_usage.sql` again (the file is not in
  the previous release) and the unit boots on the old code.

## PR description

The PR carries this block verbatim:

````
```cutover
{"runbook": "docs/cutover-pr-openvibe-billing-6.md", "rehearsal": "billing-usage-records-001"}
```
````

The harness reads the `runbook` and `rehearsal` from this block, refuses the
deploy until `ds/deploy/rehearsals/billing-usage-records-001.json` is
`{"ok": true}`, and otherwise proceeds with the standard `git-checkout`
recipe.