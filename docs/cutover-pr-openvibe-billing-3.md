# Cutover runbook — PR #3 (`migrations/0002_usage.sql`)

For: OpenVibers/OpenVibe.Billing pull request #3, branch `agent/billing-plan-t5-lane-f-next-075725-muqo76d4`.
Rehearsal name (for `ds/deploy/rehearsals/<name>.json`): `billing-3-usage-records`.

## What this changes

One migration, `migrations/0002_usage.sql`, **phase: expand**, and one new table:

- `usage_records` (`id`, `idempotency_key` unique, `project`, `subject`, `service`, `at`, `reading` jsonb,
  `reading_hash`, `principal`, `received_at`) plus four indexes (`at`, `project`, `subject`, `service`).
- **Additive only.** No existing table, column, index or row is altered, and the migration reads nothing.
- **No money moves.** `POST /api/v1/usage` (`server/api/v1.js:253`, `server/ops/usage.js`) stores a
  `platform.usage-sample@1` reading and writes no transaction and no ledger entry; `GET /api/v1/usage`
  (`v1.js:258`) only lists. The outbox, freeze state, balances and the Live↔Billing authority split are
  untouched, so — unlike `docs/live-cutover.md` — this cutover needs **no freeze** and no Live action.

Migrate runs by itself: `openDb()` (`server/db.js:44-49`) applies every `migrations/NNNN_*.sql` as the owner
role over `DATABASE_DIRECT_URL` (direct, to PgBouncer's server) *before* the serving handle opens, on each
process start. There is no separate migrate step to invoke; deploying the merged commit restarts
`openvibe-billing.service` and applies `0002_usage.sql` at boot.

## Order

1. **Window and preconditions.** Any time; no quiesce is required because the migration is additive and
   non-monetary. Confirm the running release and health first:
   `ov access run openvibe-ovh show billing`, `curl -s http://127.0.0.1:4600/api/health`.
   Nothing posts usage readings in production yet, so no client breaks if the route appears a restart late.
2. **Back up `ov_billing`** (the way back). As on the host, into Billing's own state directory, matching the
   `docs/live-cutover.md` step-3 convention (`/var/lib/openvibe-billing` is the unit's `StateDirectory`,
   owned by `ubuntu`):
   `sudo -u ubuntu pg_dump "$DATABASE_DIRECT_URL" -Fc -f /var/lib/openvibe-billing/ov_billing-pre-0002.dump`
   (a second copy under `/var/backups/openvibe` if the operator keeps backups there).
3. **Deploy the merged commit** through the pipeline (Billing deploys through its own pipeline; do not
   raw-restart it). The deploy restarts the unit; the migration runs at boot in the same step.
4. **Verify** (next section). Only then does the release count as cut over.
5. **Keep the dump** until the next release has settled; then the pre-`0002` dump may be retired.

## Verification

1. **Migration applied** — table and indexes exist, as the owner over the direct URL:
   `psql "$DATABASE_DIRECT_URL" -c '\d+ usage_records'` shows the nine columns, the `idempotency_key`
   unique index and the four `usage_records_*` indexes; `SELECT count(*) FROM usage_records` is `0` on a
   fresh cutover. The service log shows the migration ran with no error at boot.
2. **Service healthy** — `curl -s http://127.0.0.1:4600/api/health` returns 200 with the same
   `frozen`/`authority` values as before the deploy (this change must not move either).
3. **Route works, idempotently** — with a service token: `POST /api/v1/usage` a `platform.usage-sample@1`
   reading carrying an `idempotency_key`; expect 200 and a row. Re-POST the byte-identical reading (any key
   order) with the same key: expect the same row and `SELECT count(*) FROM usage_records` still `1`. Re-POST
   the same key with a *different* reading: expect `409 billing.usage_key_reused` and the stored row
   unchanged.
4. **Reads are gated** — `GET /api/v1/usage` with a staff token (`billing.ledger.admin`) lists the reading;
   the same GET with a plain service/usage token is refused, and a user token is refused.
5. **Money untouched** — no new journal rows and balances unchanged across the two POSTs;
   `npm run reconcile` still reports clean. The table is not read by the reconciler.

## Way back

The migration is additive, so the way back is a plain redeploy, not a data restore:

- **Preferred:** deploy the previous Billing commit (pipeline, or `--restart --wait-idle` per the deploy
  tooling). Older code ignores `usage_records`; the table and any readings taken since are harmless.
  Optionally `DROP TABLE usage_records;` afterwards if the operator wants the schema pristine — the only
  loss is non-monetary readings recorded since the deploy.
- **If boot fails on the migration itself** (it only creates objects, so this is unlikely): stop
  `openvibe-billing`, restore the step-2 dump over `ov_billing`
  (`pg_restore --clean --if-exists -d "$DATABASE_DIRECT_URL" /var/lib/openvibe-billing/ov_billing-pre-0002.dump`),
  deploy the previous commit, start the unit. Because `0002` added only an empty table, the snapshot is
  identical to a clean pre-migration state.
- **No Live action, no reconciliation, no freeze to unwind**: this change moves no money and does not touch
  the Live↔Billing authority split, so nothing has to be re-derived on the Live side.
