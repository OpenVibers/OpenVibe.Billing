# OpenVibe.Billing

> The isolated money ledger: providers, receipts, subscriptions, entitlements, refunds and payouts.

**Status:** alpha — runtime built and tested (Wave 8). Deployed on the host in **shadow** mode
since 2026-09-23 (`/opt/openvibe.billing`, API on `127.0.0.1:4600`): no provider secret is configured,
it holds a reconciled import of a Live snapshot, and OpenVibe.Live stays the money authority
(`BILLING_AUTHORITY` is not set in Live) until the cutover below is run. The cutover has not been run.  
**Domain:** `billing.openvibe.network` — the staff console (Network SSO, staff only), `/webhooks/*` and
`/api/health`; the service API `/api/v1` is reachable only on loopback (`127.0.0.1:4600`)  
**Decision:** [ADR-012](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-012-economic-classification.md) —
economic classification. The survey behind it is [docs/economic-inventory.md](docs/economic-inventory.md).  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §11.1, §11.4, §11.5.  
**License:** AGPL-3.0.

## What it is

One append-only, balanced, double-entry journal for every MONEY and CREDIT flow on the network,
kept apart from loyalty points (OpenCoins, channel points) and from every product UI. Provider
webhooks land here and nowhere else.

| ADR-012 class | Here |
|---|---|
| CREDIT (Vibes bought, spendable, never withdrawable by the buyer) | `user_credit:<subject>` (vibes-bits) |
| MONEY (creator payable, payouts, receipts, platform revenue) | `creator_payable:<subject>`, `payouts_pending:<subject>`, `provider_clearing:<provider>`, `platform_revenue`, `refunds`, `chargeback_loss` |
| PROMO (free service allowance, plan T5 ledger 2: never spendable as CREDIT, never MONEY) | `promo_credit:<subject>` (vibes-bits), issued from and returned to `promo_reserve` (platform, vibes-bits); windows in `promo_allowances`. **Counterparty: a dedicated `promo_reserve`, not `platform_revenue`**: free allowance is a marketing cost, not income, so debiting revenue would understate earnings and blur the one account that reports what the platform made; a reserve of its own always equals −Σ `promo_credit` and is checked in isolation |
| ENTITLEMENT (channel subscriptions) | `subscriptions` + `entitlements` (one row per paid period) |
| EXTERNAL (tips on a streamer's own PowerChat) | stored receipt (`external_receipts`), no journal entry; announced as `billing.receipt.external` once Billing is the authority; a direct-route subscription grants its entitlement only |
| LOYALTY, COSMETIC, GAME-STATE, LEGACY | not here (rule 5–8) |

**Three ledgers, one journal.** Bought Vibes (`user_credit`), creator money (`creator_payable` and its payouts)
and free promo allowance (`promo_credit`) are separate account kinds that never mix. Credit becomes money only
through a transfer (`transfers.create`: `user_credit` → `creator_payable`); money leaves only through a cashout
(`creator_payable` → `payouts_pending`). Promo has no such path: it is granted by an admin
(`POST /api/v1/admin/promo/grant`: `promo_reserve` → `promo_credit`) and only drawn down by usage
(`ops/promo.js` `consume()`, keyed by the caller's idempotency key) or lapses when its window ends, both back to
`promo_reserve`. Transfers read `user_credit` only and cashouts `creator_payable` only, so a subject holding only
promo is refused with `billing.insufficient_funds`; an admin adjustment that pairs a promo account with any other
kind is refused (`billing.promo_isolated`), and reconciliation's `promo.isolated` check fails on any transaction
that mixes them. `promo_allowances` is the policy and window record (`granted_bits`, `used_bits`, `expired_bits`
per subject, service, period and window); the `promo_credit` balance is the authoritative remainder, and every
promo write changes both in one transaction.

## Owns

- the journal (`accounts`, `transactions`, `ledger_entries`, `account_balances`), provider receipts
  (`provider_events`, `external_receipts`), intents, subscriptions and entitlements, cashouts, usage readings
  (`usage_records`), promo allowances (`promo_allowances`), the freeze, reconciliation runs, import runs and the
  staff audit log, in Billing's own PostgreSQL database (`ov_billing` on the host's data role, ADR-035;
  schema in [migrations/](migrations/))
- provider webhooks (PowerChat, Stripe, PayPal, CCBill, NOWPayments): they land here and nowhere else
- the `billing.*` events and the public billing policy page (`/policy`, every number from the rates)

## Does not own

- loyalty points, cosmetics, game state (ADR-012 rules 5–8): OpenCoins stay in Network, channel points
  in Live
- product UIs: tips (OpenVibe.Tips), memberships and perks (OpenVibe.VIP), checkout pages (each product)
- identity (OpenVibe.Network)

## Depends on

- OpenVibe.Network (JWKS for service tokens; SSO with PKCE for the staff console; `identity.subject.resolve` for the Live import)
- OpenVibe.Events (the outbox relay, only when `EVENTS_URL` is set)
- the payment providers whose secrets are configured (none in production today)
- `openvibe-contracts` v0.122.1, `openvibe-sdk` v0.35.0 (service tokens, per-person limits, `openvibe-sdk/db`, `openvibe-sdk/service`), `openvibe-shared` v2.20.0, pinned by release tarball
- **PostgreSQL 18 and Valkey 9** (OpenVibe.Host `roles/data/`, ADR-035): every read and write is async through
  `openvibe-sdk/db`; Valkey holds the per-person limit counters (optional: without `VALKEY_URL` they count in the process)

## Capabilities

Implemented here (the service manifest's `capabilities`, audience `openvibe.billing`; routes under
[API](#api)): `billing.intent.create`, `billing.transfer.create`, `billing.balance.read`,
`billing.cashout.request`, `billing.cashout.manage`, `billing.subscription.manage`,
`billing.entitlement.check`, `billing.ledger.admin` and `billing.usage.record` (usage readings; released in
Contracts v0.85.0). Callers today are Live (after the cutover),
Tips (`billing.intent.create`, `billing.transfer.create`) and VIP (`billing.intent.create`,
`billing.subscription.manage`, `billing.entitlement.check`).

Called elsewhere, as the service principal `billing`: `events.event.publish` (Events) and
`identity.subject.resolve` (Network, the Live import).

## Run it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env          # set OV_OAUTH_CLIENT_SECRET, POWERCHAT_WEBHOOK_SECRET, …
npm run dev                   # http://localhost:4600
npm test                      # 13 test files: stub Network/Events/providers, temp DBs, random ports
npm run reconcile             # reconciliation report (exit 1 on failure)
npm run freeze -- on "reason" # economy freeze from the host (status | on "<reason>" | off)
node scripts/import-live.js --live-db <snapshot> [--dry-run] [--json]
node scripts/import-live.js --live-db <snapshot> --accounts-only   # only PowerChat account → creator mappings
```

Production: `/opt/openvibe.billing`, env `/etc/openvibe/billing.env`, unit
[deploy/systemd/openvibe-billing.service](deploy/systemd/openvibe-billing.service), vhost [deploy/nginx/billing.openvibe.network.conf](deploy/nginx/billing.openvibe.network.conf).

## Design

- **Journal** (`server/ledger.js`, `server/db.js`): `accounts(kind, owner_subject, currency)`,
  `transactions(id txn_<ULID>, type, status, idempotency_key UNIQUE, reverses_txn, test, actor, metadata, …)`,
  `ledger_entries(txn_id, account_id, amount)` with signed integer minor units. Every transaction sums
  to zero **per currency** (`vibes-bits`, `usd-cents`); triggers refuse UPDATE/DELETE on entries and
  transactions; corrections are reversing transactions. `account_balances` is a cache updated in the
  same transaction and verified by reconciliation. Funds checks run inside the transaction that moves
  the money, and every money transaction is SERIALIZABLE (`ledger.js` `money()`, retried on a
  serialization failure), so two movements that each passed a check cannot both commit.
- **Two currencies.** Money arrives in cents and becomes bits through the `fx_conversion` account pair
  at the recorded value rate (`bits_per_usd`, 100 today); reconciliation checks that each transaction's
  cents side mirrors its bits side. Anything a payment exceeds the bits' value by is `platform_revenue`.
- **Rates are configuration** (`BILLING_*`, defaults = Live's): price tiers, value rate, sub price,
  70 % streamer share, 10 % site-route fee, minimum cashout, escrow days. Each transaction records the
  rates it used.
- **Receipts**: webhooks are verified, stored in `provider_events` (UNIQUE provider + event id) before
  anything else, then processed with the effect and the "processed" mark in one transaction, with the receipt's row locked.
  Every settling transaction has a unique `receipt_ref` (`<provider>:<payment id>`), so a payment
  settles once whatever event, retry or API call carries it.
- **Freeze** (ADR-012 rule 11): `settings.freeze`; while on, every mutating endpoint answers
  `503 billing.frozen`, reads work, webhooks are stored (202) and processed in arrival order after
  unfreeze. Jobs pause.
- **Outbox**: `billing.transaction.settled|reversed`, `billing.entitlement.changed`,
  `billing.subscription.canceled`, `billing.cashout.requested|paid|denied`, `billing.staff.action`,
  `billing.receipt.external`, written in the same transaction as the effect (events.event-envelope@1,
  source `billing`, actor `service:billing`). Relayed to OpenVibe.Events only when `EVENTS_URL` is set.
- **Authority** (`BILLING_AUTHORITY`, `live` by default = shadow; `billing` after the cutover): decides
  whether EXTERNAL tips are announced (see below). Anything else stops Billing at boot.
- **EXTERNAL receipts** ([server/ops/external.js](server/ops/external.js)): a PowerChat tip paid to the
  streamer's own account is stored once per payment in `external_receipts` (never in the journal) and,
  under `billing`, announced once as `billing.receipt.external` — subject `provider_receipt
  powerchat:<payment id>`, payload `streamer` (SubjectRef), `amount_cents`, `currency`, `value_bits`,
  `donor_name` (null when `anonymous`), `anonymous`, `message`, `provider`, `provider_event_id` (the
  payment's id), `delivery_id`, `receiving_account`, `app_ref`/`app_purpose` (goal pick), `occurred_at`,
  `test`. OpenVibe.Tips turns it into the chat line, alert and goal progress Live's webhook used to
  produce. The streamer is whoever the receiving account is mapped to in `provider_accounts` (the importer
  copies Live's `powerchat_connections`; an operator can add one); an unmapped account's tip is held for
  review and announced when reprocessed after mapping. Under `live` it is recorded, not announced —
  Live's own webhook announces it, so a tip is never celebrated twice.

## Rates (usage rating)

Billing turns stored usage readings (`POST /api/v1/usage`) into charges in a **background sweep**
([server/ops/rating.js](server/ops/rating.js)), never inside `POST /api/v1/usage`: a producer never drives a
synchronous debit. A reading without `vibes_charged` in `GET /api/v1/usage` is simply not rated yet.

- **Two gates, both closed by default.** The sweep runs only when `BILLING_RATING_INTERVAL_MS` is set (default
  `0` = off; `BILLING_RATING_BATCH` readings per pass, 500), and **nothing is charged without a rate card**.
  Rate cards are loaded **only by review**: `OV_RATE_CARDS` (a JSON array of `platform.rate-card@1`, inline or
  a file path) + `node scripts/load-rate-cards.js [--dry-run]` (`npm run load-rate-cards`). Every card is
  validated against the contract first and one bad card loads nothing; no request and no AI writes a card.
- **Card match.** A reading's `provider` and `resource` are the card's `provider` and `metric`; the card's
  region (none = every region) and effective dates (`effective_from` ≤ the reading's UTC day <
  `effective_until`) must fit. Its `unit` must be the one the metric names (the metric itself or its leading
  word: `GiB` for `gib-delivered`, `requests` for `request`); no unit is converted.
- **The charge.** `quantity / unit_size × unit_price_usd × bits_per_usd`, computed exactly and rounded up once
  to whole vibes-bits. The subject's promo allowance (`promo_credit`, step 5) covers it first; the rest is
  **one `usage` transaction per reading**, `user_credit:<subject>` → `platform_revenue` (vibes-bits), idempotency
  key `usage:<reading idempotency_key>`. The allowance draw is a promo `adjustment` (`promo_credit` →
  `promo_reserve`) in the same database transaction, so promo bits never reach `platform_revenue` or creator
  earnings. The reading records `vibes_charged` (bits), `promo_bits`, `free_allowance_used` (in the reading's
  own unit), `rated_at` and `txn_id` (the `usage` transaction, or the promo draw when nothing was charged). A
  card's own `free_allowance` (the provider's free tier) is stored with the card, not applied per person.
- **Hard budgets** (`usage_budgets`, `POST /api/v1/admin/budgets`): per subject + service (`'*'` = every
  service) + window (`day`, `month`, `none`). A charge that would take an open budget's `spent_bits` past
  `budget_bits` is **refused whole** (`billing.budget_exceeded`): nothing is charged, no allowance drawn, the
  reading stays unrated. `spent_bits` grows in the same transaction as the ledger post. A window that ends opens
  the next with the same budget. **With no budget row only the spendable balance limits the charge**
  (`billing.insufficient_funds`). `budget_bits: 0` stops all further charges.
- **Unrated, never partly charged.** The funds check, the budget check, the allowance draw, the post and the
  "rated" mark are one serializable transaction that claims the reading's row (`FOR UPDATE SKIP LOCKED`), so
  two sweeps, or a sweep and `POST /api/v1/admin/rate`, never charge or draw twice. `rating_error` says why a
  reading waits: `billing.insufficient_funds` / `billing.budget_exceeded` are tried again after
  `BILLING_RATING_RETRY_MS` (1 h); `billing.no_rate_card` / `billing.unit_mismatch` wait until a matching card
  is loaded (the loader makes them due again); `billing.no_subject` (no `user:usr_…` subject, e.g. an app's
  job) is never charged. Nothing is rated while the economy is frozen.

## API

All `/api/v1` calls need a service token from OpenVibe.Network (audience `openvibe.billing`) and are
made on loopback (`http://127.0.0.1:4600`); nginx refuses `/api/v1` on the public host. Every
POST needs an `Idempotency-Key` (8–200 of `A-Za-z0-9._:-`); a replay returns the original response
(`Idempotent-Replayed: true`), the same key with another body is `422 idempotency.key_reused`, refusals
are not stored. Errors are RFC 9457 problem+json. People are SubjectRefs `{ "type": "user", "id": "usr_…" }`
(path parameters take the bare id); amounts are integer bits or cents.

| Method & path | Capability | Does |
|---|---|---|
| `GET /api/health`, `/api/ready` | — | liveness / readiness (DB + Network key) |
| `GET /api/v1/rates` | — | prices, packages, sub price/share/fee, cashout rules, enabled providers |
| `POST /api/v1/intents` | `billing.intent.create` | start a checkout `{provider, kind: purchase\|subscription, subject, bits \| streamer, route?, auto_renew?}`; amount priced here; returns the provider checkout URL, or `checkout_ref` (`pcorder:`/`pcsub:`) for PowerChat |
| `GET /api/v1/intents/:id`, `POST …/:id/capture` | `billing.intent.create` | read; capture an approved PayPal order |
| `POST /api/v1/purchases/settle` | `billing.ledger.admin` | settle a verified provider receipt `{provider, provider_ref, amount_cents, subject \| intent_id, bits?}` |
| `POST /api/v1/transfers` | `billing.transfer.create` | tip/donation `{from, to, amount, kind?, target? (EntityRef), message?}`; self-dealing refused by subject |
| `POST /api/v1/transfers/:id/refund` | `billing.transfer.create` | give a credit-funded transfer back `{amount?, reason?}` (refused if the recipient no longer holds it) |
| `POST /api/v1/recycle` | `billing.cashout.request` | creator payable → own spendable credit `{subject, amount}` |
| `POST /api/v1/cashouts` | `billing.cashout.request` | `{subject, amount, payout_method: {type, address}}` → escrow |
| `GET /api/v1/cashouts[?status&subject]`, `GET …/:id` | `billing.cashout.manage` (`…request` for one) | list / read |
| `POST /api/v1/cashouts/:id/approve` | `billing.cashout.manage` | `{payout_reference (required), payout_provider?}`; refused before the escrow ends |
| `POST /api/v1/cashouts/:id/deny` | `billing.cashout.manage` | reversal back to payable `{reason?}` |
| `POST /api/v1/subscriptions` | `billing.subscription.manage` | start/renew a period `{subscriber, streamer, source: credit, auto_renew?}` (share credited every period); `source: receipt` also needs `billing.ledger.admin` |
| `POST /api/v1/subscriptions/:id/cancel` | `billing.subscription.manage` | cancel at period end; Stripe is cancelled at Stripe first |
| `POST /api/v1/subscriptions/:id/refund` | `billing.ledger.admin` | staff refund of one whole period paid from credit `{transaction_id \| period_end, reason}` → 201 `{transaction, subscription, entitlement}`; the period is revoked (the subscription is shortened, or ends with its last period); a period already refunded or charged back → 200 `{transaction: null, noop: "already_reversed", reversed_by}`; a receipt-paid period → 422 `billing.not_refundable` (its provider reverses it) |
| `GET /api/v1/subscriptions[?subscriber&streamer&status]`, `GET …/:id` | `billing.entitlement.check` | read |
| `GET /api/v1/entitlements/:subject[?streamer=]` | `billing.entitlement.check` | `{active, expires_at, grace_until, subscription}` — needs nothing but Billing; `grace_until` is set only while the subscription is `past_due` (never active) |
| `GET /api/v1/balances/:subject` | `billing.balance.read` | `{credit, payable, pending_payouts, promo_bits, payable_value_cents}` (`promo_bits`: unused free allowance, never transferable) |
| `GET /api/v1/transactions?subject=&cursor=&limit=`, `GET …/:id` | `billing.balance.read` | history (cursor paging), one transaction with `reversed_by` |
| `POST /api/v1/usage` | `billing.usage.record` | store a `platform.usage-sample@1` reading (charges nothing here: the rating sweep does, see Rates; accepted while frozen); idempotent by the reading's `idempotency_key`: same money fields (`service`, `project`, `subject`, `resource`, `provider`, `operation`, `quantity`, `unit`, `at`; `at` as an instant, absent = null) → 200 with the first stored row, unchanged (`Idempotent-Replayed: true`), different money fields → 409 `billing.usage_key_reused`; placement and correlation fields (`node`, `cell`, `region`, `route_epoch`, `trace_id`, `source`, `cost_estimate`, `free_allowance_used`, `vibes_charged`) never cause a 409; no `Idempotency-Key` header |
| `GET /api/v1/usage?project=&subject=&service=&from=&to=&limit=&cursor=` | `billing.ledger.admin` | readings newest first, `from` ≤ `at` < `to`, cursor paging (`limit` ≤ 500) |
| `GET\|POST /api/v1/admin/freeze` | `billing.ledger.admin` | read / set `{on, reason?}`; unfreeze drains queued webhooks |
| `GET /api/v1/admin/reconcile` | `billing.ledger.admin` | run + store a reconciliation |
| `GET /api/v1/admin/reconciliations[?limit&failed=1]`, `GET …/:id` (`latest`) | `billing.ledger.admin` | stored runs (scheduled and on demand) with their trigger; one full report |
| `GET\|POST /api/v1/admin/provider-accounts` | `billing.ledger.admin` | list / map `{provider, username, account_id?, subject}` a provider account to its creator (allowed while frozen) |
| `POST /api/v1/admin/adjustments` | `billing.ledger.admin` | `{from: account, to: account, amount, reason, relates_to?}` (same currency; a promo account only against the other promo kind) |
| `POST /api/v1/admin/promo/grant` | `billing.ledger.admin` | `{subject, bits, service? ('*'), period? (day \| month \| none; month)}` → 201 `{allowance, transaction}`: tops up the current window (a second grant in it adds); idempotent by `Idempotency-Key` |
| `POST /api/v1/admin/rate` | `billing.ledger.admin` | one rating pass now `{batch?}` → `{rated, skipped, busy, failed}` (refused while frozen; no `Idempotency-Key` needed: rating is idempotent per reading) |
| `GET /api/v1/admin/budgets?subject=`, `POST /api/v1/admin/budgets` | `billing.ledger.admin` | hard usage budgets; set `{subject, service? ('*'), period? (day \| month \| none; month), budget_bits}` for the window open now (keeps what it has spent) |
| `GET /api/v1/admin/provider-events[?pending=1]`, `POST …/:id/reprocess` | `billing.ledger.admin` | receipts; retry an unprocessed/rejected one |
| `POST /api/v1/admin/sweep`, `GET /api/v1/admin/import-holds` | `billing.ledger.admin` | renewal sweep now; unmapped import users |
| `POST /webhooks/<provider>` | provider signature | `powerchat`, `stripe`, `paypal`, `ccbill` (GET too), `nowpayments` |
| `GET /metrics` | direct loopback caller | Prometheus text (openvibe-shared/metrics): HTTP golden signals, process, `release_info`, and `billing_*` gauges — freeze, authority, receipts by state, oldest pending receipt, EXTERNAL receipts, outbox backlog, cashouts, the latest reconciliation. 404 to anything a proxy relayed; nginx answers 404 on the public host |

The existing capabilities and service manifest are released in openvibe-contracts (v0.8.0;
`billing.staff.action` since v0.17.0). `billing.usage.record` is released in Contracts v0.85.0: input is
`platform.usage-sample@1`; output is `billing.usage-record-result@1` =
`{ record: { id, idempotency_key, project|null, subject|null, service, at, received_at, principal, reading } }`,
201 when stored and 200 with `Idempotent-Replayed: true` on a replay; `GET /api/v1/usage` needs
`billing.ledger.admin` and returns `{ records, next_cursor }`. Network grants `billing.usage.record`
(audience `openvibe.billing`) to each producer service in `server/identity/principals.js`, and no service
holds it yet: the first producer gets the grant in the same change that wires its calls. Grants are matched
with contracts' own `capabilities.grants()` (exact id or a `.*` family such as `billing.*`).

### Per-person limits

The money-creating routes also limit how often one person can use them: `server/api/actor-limits.js`,
openvibe-sdk/limits, roadmap WS-R task 4. Every caller is a first-party service acting for many people,
so nothing is counted per service: a request counts against the person its body names (the buyer, the
payer, the creator, the subscriber), whichever service sends it; a refund counts against the payer of the
transfer it gives back. The limit runs after the capability and freeze checks (a request refused while
frozen is not counted) and before the idempotency store and the ledger, so a refusal stores nothing and
the same `Idempotency-Key` works after `Retry-After`. Past a limit: `429` problem+json `rate_limited`, one log line and
`billing_rate_limited_total{limit,window}`. `BILLING_LIMITS=off` turns them all off (a rollback lever).

| Route | Per person, a minute / an hour |
|---|---|
| `POST /api/v1/intents` (checkout) | 5 / 30 |
| `POST /api/v1/transfers` (per payer) | 60 / 1200 |
| `POST /api/v1/transfers/:id/refund` (per payer of the transfer) | 20 / 200 |
| `POST /api/v1/cashouts` (payout request) | 3 / 10 |
| `POST /api/v1/recycle` | 10 / 60 |
| `POST /api/v1/subscriptions` (per subscriber) | 10 / 60 |
| `GET /api/v1/transactions?subject=` (history) | `BILLING_LIMITS_MINUTE` / `BILLING_LIMITS_HOUR` (120 / 3000) |

Never limited: the provider webhooks (`/webhooks/*`), capturing an approved order, cashout approve and
deny, subscription cancel, the freeze, every admin route, the staff console, balance and entitlement
reads, `/api/health`, `/api/ready`, `/release.json` and `/metrics`. `test/actor-limits.test.js`.

## Staff console

Server-rendered pages at the root of `https://billing.openvibe.network` for the people who decide
payouts — the replacement for Live's cashout admin, which answers 409 once Live runs with
`BILLING_AUTHORITY=billing` ([docs/live-cutover.md](docs/live-cutover.md)). No JavaScript, no external
resources, `noindex`, `Cache-Control: no-store`, a strict CSP (`default-src 'none'`, `form-action 'self'`,
`frame-ancestors 'none'`). Code: [server/console/](server/console/); tests: `test/console.test.js`.

**Sign-in:** OpenVibe.Network SSO, authorization code with PKCE (S256), as OAuth client `billing`
(redirect `https://billing.openvibe.network/auth/callback`, which the Network must list for that
client). The code is exchanged server to server on `OV_NETWORK_INTERNAL_URL`; the access token is
verified offline with the Network key Billing already loads (issuer, audience `openvibe.network`,
expiry). Billing keeps none of the Network's tokens — the refresh token it is handed is revoked at once.

**Who:** a person whose Network token says `role: "admin"` **and** whose subject (`subject_id`, a
`usr_…`) is listed in `BILLING_STAFF_SUBJECTS`. Everyone else gets 403 and no session; the refusal is
recorded in the audit log. The list is re-checked on every request: removing someone ends their session
on their next click.

**Session:** cookie `__Host-ovb_staff` — random 256-bit id (the database keeps only its SHA-256),
host-only, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Strict`, absolute lifetime `BILLING_SESSION_TTL_MIN`
(60 min). The OAuth state + PKCE verifier travel in a 10-minute `ovb_flow` cookie (`Path=/auth`,
`SameSite=Lax` for the return from openvibe.network) signed with `BILLING_SESSION_SECRET`. Every form
carries the session's CSRF token (constant-time compare) and cross-site `Origin` / `Sec-Fetch-Site`
POSTs are refused. Sign-out is a POST.

**What staff may do** is expressed in the API's own capability ids: a staff session is the principal
`{ sub: <usr_…>, cap: [billing.cashout.manage, billing.ledger.admin] }` and every page names the one
capability it needs. Every action calls the same functions the API does — `ops/cashouts.approve|deny`,
`ops/admin.setFreeze` (+ processing the held webhooks on unfreeze), `reconcile()`,
`providers.reprocess()` — behind the same freeze guard; there is no second implementation.

| Page | Needs | Does |
|---|---|---|
| `/` | staff | freeze state, last reconciliation, outstanding credit / payable / pending payouts (test transactions excluded), queue counts |
| `/cashouts?tab=escrow\|ready\|paid\|denied` | `billing.cashout.manage` | the queue with escrow dates (Billing has no separate "approved" state: approving records a payout already made, so it is **paid**) |
| `/cashouts/:id` | `billing.cashout.manage` | detail; **approve** needs the provider's payout reference, a payout provider and a ticked confirmation, and is refused before the escrow ends; **deny** needs a reason and returns the amount to the creator's payable. A resubmitted form replays (per-form action key → the ops idempotency key), never pays twice |
| `/receipts` | `billing.ledger.admin` | provider receipts flagged for review (unattributed site tips, underpaid deliveries, held site-routed tips), rejected ones (incl. deliveries for orders Live already credited — `billing.intent_settled_in_live`), stored-but-unprocessed ones, reversals flagged `review: required`; reprocess an unprocessed/rejected one. Shown by id and outcome only — never the provider payload |
| `/import-holds` | `billing.ledger.admin` | unmapped Live users from the importer |
| `/reconciliation`, `/reconciliation/:id` | `billing.ledger.admin` | run + history; a run shows checks, offender counts, warning counts and totals |
| `/freeze` | `billing.ledger.admin` | freeze / unfreeze with a mandatory reason |
| `/audit` | `billing.ledger.admin` | the staff audit log |

**Audit:** every staff action — sign-in, sign-out, approve, deny, freeze, unfreeze, reconciliation run,
reprocess — and every refused attempt (non-staff sign-in, CSRF failure, a refused approval) is one row
in the append-only `staff_audit` table (actor subject and username, action, target, reason, outcome,
a small detail such as the payout reference or refusal code, request id, and an HMAC of the client IP
keyed by `BILLING_SESSION_SECRET`). Done actions are also written to the outbox as
`billing.staff.action` (visibility `internal`, actor = the staff subject), in the same
transaction as their effect. Adjustments are not in the console; they stay on the API
(`POST /api/v1/admin/adjustments`).

## Providers

| Adapter | Enabled when | Settles | Reverses |
|---|---|---|---|
| PowerChat | `POWERCHAT_WEBHOOK_SECRET` | `donation.completed` with `pcorder:` (purchase), `pcsub:` (site → share; direct → EXTERNAL entitlement), `pcdon:` (site-routed tip → payable); any other tip on a streamer's own account → EXTERNAL receipt (`billing.receipt.external` under `billing`) | `donation.refunded`, `donation.disputed`/`donation.chargeback` (event names to confirm with PowerChat) |
| Stripe | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | `checkout.session.completed` (payment), every `invoice.paid` | `charge.refunded` (cumulative), `charge.dispute.funds_withdrawn` |
| PayPal | client id + secret + `PAYPAL_WEBHOOK_ID` | `PAYMENT.CAPTURE.COMPLETED`, capture after return | `PAYMENT.CAPTURE.REFUNDED`, `…REVERSED` |
| CCBill | `CCBILL_WEBHOOK_SECRET` | `NewSaleSuccess` (reported price required) | `Refund`, `Void`, `Chargeback` |
| NOWPayments | `NOWPAYMENTS_IPN_SECRET` | `finished`/`confirmed`/`sending` | `refunded` |

Only PowerChat is expected to be enabled in production. A reversal of a purchase claws back the
buyer's remaining credit; credit already given to someone stays with them — their payable is never
touched — and the unrecovered value goes to `chargeback_loss`, flagged `review: required`.
Reversing a subscription payment revokes the periods it granted. A period paid from credit has no receipt:
staff refund it whole (`POST /api/v1/subscriptions/:id/refund`, one `refund` transaction reversing the period's
payment): the subscriber gets the credit back (never the promo allowance, which pays no period), platform
revenue gives back its part, and the creator share comes back out of `creator_payable` as far as it is still
there — a share already recycled or cashed out goes to `chargeback_loss`, flagged `review: required`.

## Operations

- **Reconciliation** runs **every hour on its own** (`BILLING_RECONCILE_INTERVAL_MS`, a first run a
  minute after boot, also while frozen — it only reads) and on demand (`npm run reconcile`,
  `GET /api/v1/admin/reconcile`, the console's Reconciliation page, after every import). It checks: journal
  zero-sum per currency, per-transaction balance, cached balances = entry sums, fx mirror, every settled
  provider event has exactly one transaction, paid cashouts have payout references, payouts_pending =
  requested cashouts — and the ledger against the provider receipts: every transaction settled from a
  receipt names its provider and moved exactly the receipt's cents through that provider's clearing
  account (`receipts.ledger`), EXTERNAL receipts are never in the journal and each announced one has one
  outbox event (`receipts.external`), and no receipt waits unprocessed longer than
  `BILLING_RECONCILE_STALE_RECEIPT_MIN` (60) while the economy is open (`receipts.stale`) — and every paid
  period against its charge: a granted period rests on an unreversed subscription transaction (periods imported
  from Live are counted, not failed) and a period revoked for a refund or chargeback has its payment's reversal
  (`subscriptions.period_charged`). It also lists
  negative balances, unprocessed/rejected events, items for review and import holds; totals exclude test
  transactions. Every run is stored in `reconciliation_runs` with its trigger (`scheduled`, `api`,
  `console`, `script`, `import`); passing scheduled runs older than `BILLING_RECONCILE_KEEP_DAYS` (30) are
  pruned, failed ones are kept. Results: the console, `GET /api/v1/admin/reconciliations`, and `/metrics`
  (`billing_reconciliation_ok`, `…_failed_checks`, `…_last_run_timestamp_seconds`); a failed scheduled run
  is also logged.
- **Renewals** run in the hourly subscription sweep (`BILLING_SWEEP_INTERVAL_MS`, not while frozen; on demand
  `POST /api/v1/admin/sweep`): a credit subscription whose period ended is charged once from the subscriber's
  credit (never the promo allowance) under `renew:<sub>:<period end>` — `…:<k>` after `k` charges under that
  period's earlier keys were refunded or charged back — so a retried, replayed or concurrent sweep charges and
  credits the creator share once. A renewal the credit cannot pay leaves the subscription `past_due`
  for `BILLING_RENEWAL_GRACE_DAYS` days past the period end (default **3**; set `0` to end it at once
  with `renewal_insufficient_credit`): no access meanwhile (event reason `renewal_failed`), every
  later sweep retries the same key (a top-up is picked up; a cancel ends it), and past `grace_until` it
  expires (`grace_ended`). Turning the grace on (or off): [docs/renewal-grace-cutover.md](docs/renewal-grace-cutover.md).
- **Freeze** before any risky change: the console's Freeze page, `POST /api/v1/admin/freeze {"on": true, "reason": "…"}`, or on the
  host `node scripts/freeze.js on "<reason>"` (same switch; after `off` the running service processes the
  held webhooks on its next retry tick).
- **Review queue**: chargebacks on donated credit and unattributed site tips appear under
  `warnings` and on the console's Receipts page; resolve them with an adjustment (`relates_to` = the transaction).
- **Payouts** are decided in the staff console (or with `billing.cashout.manage` on the API): pay at the
  provider, then approve with its payout reference once the escrow has ended.
- **Metrics**: `curl -s http://127.0.0.1:4600/metrics` on the host.
- **Backups**: `pg_dump ov_billing > billing-$(date +%F).sql` (the host's data role, ADR-035).
- **Mapping of Live's tables** to Billing's (including payouts, refunds and plans, which have no table
  of their own on Live): [docs/live-mapping.md](docs/live-mapping.md).

## Acceptance

`npm test` runs every `test/*.test.js` against stub Network, Events and providers, temp databases and
random ports. What they prove: the journal balances per currency and refuses edits
(`ledger.test.js`); a receipt settles once whatever retries carry it, and reversals claw back only what
can be (`webhooks.test.js`, `providers.test.js`, `stripe.test.js`); subscriptions and entitlements
(`subscriptions.test.js`); a renewal is one charge per period, a failed one is retried on its key in the
grace and then ended, a promo allowance never pays it (`renewal-grace.test.js`); a credit-paid period is refunded
whole and once, the creator share clawed back or booked as loss, and every paid period has its charge record
(`subscription-refund.test.js`); EXTERNAL receipts are announced once and only under `billing`
(`external.test.js`); the import reconciles (`import.test.js`); freeze, reconciliation and review
(`operations.test.js`); the cutover sequence (`cutover.test.js`); the staff console and its staff map
(`console.test.js`, `staff-map.test.js`); the public policy (`policy.test.js`); the vhost keeps `/api/v1`
off the public host (`nginx-vhost.test.js`, `security.test.js`); per-person limits
(`actor-limits.test.js`); service auth and the outbox (`auth-outbox.test.js`).

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Auth.** `/api/v1` answers only on loopback (nginx denies it publicly) and needs a Network service
  token for audience `openvibe.billing` with the route's capability; every POST needs an
  `Idempotency-Key`. The staff console is Network SSO with PKCE, limited to `BILLING_STAFF_SUBJECTS`,
  and every staff action is audited (`billing.staff.action`).
- **Money integrity.** The journal is append-only (triggers refuse UPDATE/DELETE), every transaction
  sums to zero per currency, funds checks run inside the transaction that moves money, and a receipt is
  stored before it is processed. The freeze stops every mutation; hourly reconciliation checks the
  ledger against the receipts.
- **Webhooks.** Each provider's signature is verified before anything is read; a disabled provider
  answers 404. A buyer-editable reference on a tip to a creator's own account moves no money
  (`test/security.test.js`).
- **Secrets.** Provider secrets (`POWERCHAT_WEBHOOK_SECRET`, `STRIPE_*`, `PAYPAL_*`, `CCBILL_*`,
  `NOWPAYMENTS_*`), `OV_OAUTH_CLIENT_SECRET` and `BILLING_SESSION_SECRET` live in
  `/etc/openvibe/billing.env` (0600), by name only. `/metrics` answers direct loopback callers only.
- **Egress.** Billing calls Network, Events and the enabled providers' APIs only.

## Deploy

Production deploys with `sudo ovhost deploy billing` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.billing`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-billing.service` on `127.0.0.1:4600`, the env file `/etc/openvibe/billing.env`. The ledger is
`ov_billing` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh billing` writes its settings);
the release applies `migrations/` at boot as the owner (`DATABASE_DIRECT_URL`), and every read and write is async
through `openvibe-sdk/db`. nginx serves `billing.openvibe.network` from
[deploy/nginx/billing.openvibe.network.conf](deploy/nginx/billing.openvibe.network.conf) (console, `/policy`,
`/webhooks/*`, `/api/health`). Freeze the economy before any risky change (below).
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback billing --to <sha>`. Migrations only add tables and columns.
`BILLING_LIMITS=off` turns the per-person limits off without a deploy.

## Cutover runbook (Live → Billing)

The exact production sequence, rollback, grants and the Live behaviour the switch cannot preserve are in
[docs/live-cutover.md](docs/live-cutover.md); the Live side (a `BILLING_AUTHORITY=live|billing` switch,
`live` by default, plus the `money_writes_frozen` freeze) was the patch
[docs/live-patch.diff](docs/live-patch.diff) and is deployed in OpenVibe.Live since `c384787` with the
switch unset. None of the steps below has been executed yet; step 3 needs the owner (PowerChat
dashboard). In short:

1. **Shadow import** as often as needed (`node scripts/import-live.js --live-db <snapshot> [--dry-run]`);
   map held users in the Network and explain every adjustment until reconciliation is clean.
2. **Freeze Live money writes**, wait for in-flight PowerChat checkouts (an hour), back up and **freeze Billing**,
   set `BILLING_AUTHORITY=billing` in billing.env (EXTERNAL tips are then announced for Tips).
3. **Re-point the PowerChat webhook** to `https://billing.openvibe.network/webhooks/powerchat` (Billing holds
   the deliveries while frozen), then take the **final snapshot and import**; reconcile.
4. **Switch Live** (`BILLING_AUTHORITY=billing`, deploy with `--wait-idle`), **unfreeze Billing** (held
   deliveries settle; ones Live already credited are rejected for review, never credited twice).
5. **Verify** the reads, **unfreeze Live**, verify with a small real PowerChat purchase.

Import runs are safe after cutover too: an order Live credited is imported as settled-in-Live and never
settles again here, and opening balances only ever correct the imported part of an account, never what
Billing did itself.

## Launch rule

`billing.openvibe.network` left OpenVibe.Sites on 2026-09-23: it serves the staff console only. Billing
is not a public product and is not the money authority until the cutover above and everything in plan
§12.12 holds: owning runtime with health/readiness and `/metrics` ✔; canonical identity and
scoped service principals ✔ (principal `billing`); server-rendered public routes useful without
JavaScript (partly — the public billing policy at `/policy`; the other pages are the staff-only console); real persistence and end-to-end
workflows ✔ in tests, shadow only in production; capability/event registration against
OpenVibe.Contracts ✔ (v0.8.0); migration strategy ✔ (shadow import reconciles; restore drill passed
2026-09-23) with a security review, sitemap/robots still to do; acceptance tests ✔. A shadow deployment
is never counted as the money authority.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.122.1
- openvibe-sdk: v0.35.0
- openvibe-shared: v2.20.0
<!-- versions:end -->
