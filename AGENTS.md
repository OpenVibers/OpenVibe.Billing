# AGENTS.md — OpenVibe.Billing

## Project overview

The isolated money ledger of the OpenVibe network: one append-only, balanced, double-entry journal
for every MONEY and CREDIT flow, provider receipts, subscriptions and entitlements, refunds,
cashouts, usage rating, promo allowances and Vibes Pay. Node.js/Express, PostgreSQL (`ov_billing`),
CommonJS, **no build step**.

- Service id `billing`, port `4600`, staff console `https://billing.openvibe.network`; the service API
  `/api/v1` is reachable **only on loopback** (`127.0.0.1:4600`), never through the public vhost.
- Authority since 2026-10-17: `BILLING_AUTHORITY=billing` in Billing and Live, PowerChat deliveries
  settle here, and Live's old money tables are read-only. Every site's account menu reads a person's
  Vibes from `GET /api/me/vibes`.
- Economic classification is [ADR-012](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-012-economic-classification.md).

## What it owns

- The journal: `accounts`, `transactions`, `ledger_entries`, `account_balances` in `ov_billing`
  ([migrations/](migrations/)); **append-only** — triggers refuse UPDATE/DELETE, and every
  transaction sums to zero per currency.
- Three ledgers that never mix: bought Vibes (`user_credit`), creator money (`creator_payable`,
  `payouts_pending`, `platform_revenue`, `refunds`, `chargeback_loss`), promo allowance
  (`promo_credit` against a dedicated `promo_reserve`, never `platform_revenue`). Credit becomes
  money only by transfer; money leaves only by cashout; promo has no such path.
- Provider webhooks (PowerChat, Stripe, PayPal, CCBill, NOWPayments) — they land here and nowhere
  else; a receipt is stored before it is processed.
- Subscriptions and entitlements, intents, cashouts, usage readings (`usage_records`), rating
  (`server/ops/rating.js`), promo windows, the freeze, reconciliation/import runs and the staff audit.
- Vibes Pay (D12): app charges, the project's `project_payable` wallet, its signed webhooks and
  sandbox Vibes ([docs/vibes-pay.md](docs/vibes-pay.md)).
- The `billing.*` events and the public billing policy page.

Not owned: loyalty points (OpenCoins, channel points), cosmetics (Inventory), game state, legacy
balances, or any product UI.

## Who calls it, and whom it calls

- Callers: every product that moves money or grants an entitlement — Live (checkouts, donations,
  subscriptions, cashouts), Tips, VIP, Inventory, Exchange and the account menus of every site. They
  use a Network **service token** audience `openvibe.billing` with the route's capability.
- Depends on: Network (JWKS, service tokens, SSO+PKCE for the console, `identity.subject.resolve` for
  the Live import); Events (SDK outbox, the `billing.*` events); the configured payment providers;
  PostgreSQL 18 and Valkey 9 (per-person limit counters; without `VALKEY_URL` they count in process).

## Repository map

- **Entry:** [server/index.js](server/index.js) — config, app, background jobs (provider event retry,
  hourly renewal sweep, hourly reconciliation, outbox relay; rating only when its interval is set).
- **App:** [server/app.js](server/app.js) — `/webhooks`, `/internal/credits`, `/api/v1/me`, `/api/v1`,
  `/api/me/vibes`, the staff console and machine endpoints.
- **Config:** [server/config.js](server/config.js), [server/config-store.js](server/config-store.js)
  (owner settings, D11), [server/internal-config.js](server/internal-config.js).
- **Database:** [server/db.js](server/db.js); schema in [migrations/](migrations/) (`0001…0018`).
- **Ledger:** [server/ledger.js](server/ledger.js), [server/money/](server/money/) (reasons),
  [server/ops/](server/ops/) — `transfers.js`, `cashouts.js`, `subscriptions.js`, `promo.js`,
  `rating.js`, `usage.js`, `intents.js`, `wallet.js`, `admin.js`.
- **API:** [server/api/](server/api/) — `v1.js`, `internal.js`, `me.js`, `webhooks.js`,
  `subject-assertion.js`, `idempotency.js`, `auth.js`, `actor-limits.js`.
- **Providers:** [server/providers/](server/providers/) — `powerchat.js`, `stripe.js`, `paypal.js`,
  `nowpayments.js`, `index.js`.
- **Console:** [server/console/](server/console/) — server-rendered, Network SSO, staff only.
- **Scripts:** [scripts/reconcile.js](scripts/reconcile.js), `freeze.js`, `import-live.js`,
  `load-rate-cards.js`.
- **Deploy:** [deploy/systemd/openvibe-billing.service](deploy/systemd/openvibe-billing.service),
  [deploy/nginx/billing.openvibe.network.conf](deploy/nginx/billing.openvibe.network.conf).

## Commands

```bash
npm ci
cp .env.example .env
npm run dev                   # http://localhost:4600
npm test                      # test/run.js, PGlite, stub Network/Events/providers
npm run test:pg               # same suite on PostgreSQL
npm run reconcile             # reconciliation report; exit 1 on failure
npm run freeze -- status|on "<reason>"|off
npm run import-live           # LIVE_DATABASE_URL=… (see README); --dry-run, --json
ov test                       # the harness's sharded run of what the change reaches
```

Tests need no network, provider key or running Network: in-process stubs, temp databases, random
ports. `npm test -- import webhooks` filters; `-- --strict` makes a skip fail.

## Database and migrations

PostgreSQL database `ov_billing` on the host's data role (ADR-035); development/tests use PGlite.
Async reads/writes through `openvibe-sdk/db`; an INSERT that needs its id uses `RETURNING id`. Schema
is `migrations/NNNN_*.sql`, applied at boot; **never edit a migration that has run** (its checksum is
recorded) and never create a table at runtime. Money integrity is enforced in SQL: the append-only
triggers, the zero-sum rule per currency and the balance checks. Do not weaken them for convenience.

## Auth, idempotency and the freeze

- `/api/v1` is loopback-only (nginx denies it publicly), needs a Network service token audience
  `openvibe.billing` with the route's capability, and **every POST needs an `Idempotency-Key`**.
  A replay with the same money fields returns the first row; different money fields are
  `409 billing.usage_key_reused` / the matching reason.
- The staff console is Network SSO with PKCE, limited to `BILLING_STAFF_SUBJECTS`; every staff action
  is audited as `billing.staff.action`.
- **The freeze** (`money_writes_frozen` / `npm run freeze`) stops every mutation: writes answer
  `503 billing.frozen`, reads still work, provider webhooks are stored (202) and processed in arrival
  order after unfreeze, and jobs pause. Rating and renewals never run while frozen.

## Frontend loading model

The only UI is the **staff console**, server-rendered HTML (no SPA, no build step, no bundler); there
is no `public/` app. `/shared/*` is served from the pinned `openvibe-shared` package where used.
Provider pages carry no product UI; a person's balance is read by each site from `/api/me/vibes`.

## Deploy

`sudo ovhost deploy billing` (strategy `git-checkout`): fetch, fast-forward `/opt/openvibe.billing`,
install on a lockfile change, restart, wait for `/api/ready`, roll back on failure. Unit
`openvibe-billing.service`, env `/etc/openvibe/billing.env` (0600), vhost
[deploy/nginx/billing.openvibe.network.conf](deploy/nginx/billing.openvibe.network.conf). The release
migrates `ov_billing` at boot; `sudo ovhost rollback billing --to <sha>`. Cutover, freeze and import
runbooks are in the README and [docs/](docs/); follow them, do not improvise a money migration.

## Tests

`npm test` runs each `test/*.test.js` in its own process through `openvibe-shared/test-runner`
(60 s/file), with stub Network/Events/providers. The suite pins the ledger invariants, the three
separate ledgers and promo isolation, promo grant/consume/lapse, idempotency, webhook storage and
ordering, the freeze, renewals/grace, reconciliation, capabilities, the public words and the
nginx/vhost rules. `test/public-words.test.js` and `test/nginx-vhost.test.js` pin files, so a copy
change may require the matching test update. `ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; factories with injectable `now`, `fetchImpl`,
  `log`, `keys`, `identity`, `adapters` and `limitsNow` so tests are deterministic.
- Amounts are integer **vibes-bits**; never use floats for money. Reasons are enum values from
  `openvibe-contracts` money reasons, not free text.
- Errors are RFC 9457 problem+json with stable codes (`billing.insufficient_funds`,
  `billing.promo_isolated`, `billing.frozen`, …).
- Secrets (provider keys, webhook secrets, OAuth) come from the environment and are never returned,
  logged or written to a file.

## Pitfalls

- **Never write money outside the ledger.** A product must call an operation, not `UPDATE` a balance.
- **Promo is not credit.** A transfer/cashout from `promo_credit` is refused; an admin adjustment
  mixing promo with another kind is `billing.promo_isolated`; reconciliation checks it.
- **Every POST needs an Idempotency-Key**; without it the route refuses, and a reused key with
  different money fields is a 409, not a second charge.
- **Webhooks are stored before processing**; never process inline and lose the receipt on a crash.
- **The freeze is global.** New mutations must check it; the relay and reconciliation are the allowed
  exceptions.
- **`/api/v1` is not public.** Do not add it to the vhost; only the console, `/webhooks/*` and
  `/api/health` are exposed.
- **Imports read Live's data, never write it.** `scripts/import-live.js` is the only bridge and needs
  `LIVE_DATABASE_URL`.
- **Tests pin copy and nginx.** Update the test with an intended change; never skip the assertion.

## Documentation

- [README.md](README.md) — the journal, routes, providers, operations and deploy runbook.
- [docs/economic-inventory.md](docs/economic-inventory.md) — every value flow and its class.
- [docs/wallet.md](docs/wallet.md), [docs/balance.md](docs/balance.md), [docs/vibes-pay.md](docs/vibes-pay.md).
- [docs/live-cutover.md](docs/live-cutover.md), [docs/cutover-usage-rating.md](docs/cutover-usage-rating.md),
  [docs/renewal-grace-cutover.md](docs/renewal-grace-cutover.md), [docs/live-mapping.md](docs/live-mapping.md).
- [docs/sdk-outbox.md](docs/sdk-outbox.md) — the event outbox.
