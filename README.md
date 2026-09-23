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
| ENTITLEMENT (channel subscriptions) | `subscriptions` + `entitlements` (one row per paid period) |
| EXTERNAL (tips on a streamer's own PowerChat) | stored receipt, no journal entry; a direct-route subscription grants its entitlement only |
| LOYALTY, COSMETIC, GAME-STATE, LEGACY | not here (rule 5–8) |

## Run it

```bash
fnm exec --using=22.22.1 npm install
cp .env.example .env          # set OV_OAUTH_CLIENT_SECRET, POWERCHAT_WEBHOOK_SECRET, …
npm run dev                   # http://localhost:4600
npm test                      # 10 test files: stub Network/Events/providers, temp DBs, random ports
npm run reconcile             # reconciliation report (exit 1 on failure)
npm run freeze -- on "reason" # economy freeze from the host (status | on "<reason>" | off)
node scripts/import-live.js --live-db <snapshot> [--dry-run] [--json]
```

Production: `/opt/openvibe.billing`, env `/etc/openvibe/billing.env`, unit
[deploy/systemd/openvibe-billing.service](deploy/systemd/openvibe-billing.service) (state in
`/var/lib/openvibe-billing`), vhost [deploy/nginx/billing.openvibe.network.conf](deploy/nginx/billing.openvibe.network.conf).

## Design

- **Journal** (`server/ledger.js`, `server/db.js`): `accounts(kind, owner_subject, currency)`,
  `transactions(id txn_<ULID>, type, status, idempotency_key UNIQUE, reverses_txn, test, actor, metadata, …)`,
  `ledger_entries(txn_id, account_id, amount)` with signed integer minor units. Every transaction sums
  to zero **per currency** (`vibes-bits`, `usd-cents`); triggers refuse UPDATE/DELETE on entries and
  transactions; corrections are reversing transactions. `account_balances` is a cache updated in the
  same SQLite transaction and verified by reconciliation. Funds checks run inside the transaction
  that moves the money.
- **Two currencies.** Money arrives in cents and becomes bits through the `fx_conversion` account pair
  at the recorded value rate (`bits_per_usd`, 100 today); reconciliation checks that each transaction's
  cents side mirrors its bits side. Anything a payment exceeds the bits' value by is `platform_revenue`.
- **Rates are configuration** (`BILLING_*`, defaults = Live's): price tiers, value rate, sub price,
  70 % streamer share, 10 % site-route fee, minimum cashout, escrow days. Each transaction records the
  rates it used.
- **Receipts**: webhooks are verified, stored in `provider_events` (UNIQUE provider + event id) before
  anything else, then processed with the effect and the "processed" mark in one SQLite transaction.
  Every settling transaction has a unique `receipt_ref` (`<provider>:<payment id>`), so a payment
  settles once whatever event, retry or API call carries it.
- **Freeze** (ADR-012 rule 11): `settings.freeze`; while on, every mutating endpoint answers
  `503 billing.frozen`, reads work, webhooks are stored (202) and processed in arrival order after
  unfreeze. Jobs pause.
- **Outbox**: `billing.transaction.settled|reversed`, `billing.entitlement.changed`,
  `billing.subscription.canceled`, `billing.cashout.requested|paid|denied`, written in the same
  transaction as the effect (events.event-envelope@1, source `billing`, actor `service:billing`).
  Relayed to OpenVibe.Events only when `EVENTS_URL` is set.

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
| `GET /api/v1/subscriptions[?subscriber&streamer&status]`, `GET …/:id` | `billing.entitlement.check` | read |
| `GET /api/v1/entitlements/:subject[?streamer=]` | `billing.entitlement.check` | `{active, expires_at, subscription}` — needs nothing but Billing |
| `GET /api/v1/balances/:subject` | `billing.balance.read` | `{credit, payable, pending_payouts, payable_value_cents}` |
| `GET /api/v1/transactions?subject=&cursor=&limit=`, `GET …/:id` | `billing.balance.read` | history (cursor paging), one transaction with `reversed_by` |
| `GET\|POST /api/v1/admin/freeze` | `billing.ledger.admin` | read / set `{on, reason?}`; unfreeze drains queued webhooks |
| `GET /api/v1/admin/reconcile` | `billing.ledger.admin` | run + store a reconciliation |
| `POST /api/v1/admin/adjustments` | `billing.ledger.admin` | `{from: account, to: account, amount, reason, relates_to?}` (same currency) |
| `GET /api/v1/admin/provider-events[?pending=1]`, `POST …/:id/reprocess` | `billing.ledger.admin` | receipts; retry an unprocessed/rejected one |
| `POST /api/v1/admin/sweep`, `GET /api/v1/admin/import-holds` | `billing.ledger.admin` | renewal sweep now; unmapped import users |
| `POST /webhooks/<provider>` | provider signature | `powerchat`, `stripe`, `paypal`, `ccbill` (GET too), `nowpayments` |

The capabilities and the service manifest are released in openvibe-contracts (v0.8.0;
`billing.staff.action` since v0.17.0); the drafts they came from stay in
[docs/capabilities-proposal/](docs/capabilities-proposal/) and
[docs/service-manifest-proposal.json](docs/service-manifest-proposal.json). Grants are matched with
contracts' own `capabilities.grants()` (exact id or a `.*` family such as `billing.*`).

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
`billing.staff.action` (visibility `internal`, actor = the staff subject), in the same SQLite
transaction as their effect. Adjustments are not in the console; they stay on the API
(`POST /api/v1/admin/adjustments`).

## Providers

| Adapter | Enabled when | Settles | Reverses |
|---|---|---|---|
| PowerChat | `POWERCHAT_WEBHOOK_SECRET` | `donation.completed` with `pcorder:` (purchase), `pcsub:` (site → share; direct → EXTERNAL entitlement), `pcdon:` (site-routed tip → payable) | `donation.refunded`, `donation.disputed`/`donation.chargeback` (event names to confirm with PowerChat) |
| Stripe | `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | `checkout.session.completed` (payment), every `invoice.paid` | `charge.refunded` (cumulative), `charge.dispute.funds_withdrawn` |
| PayPal | client id + secret + `PAYPAL_WEBHOOK_ID` | `PAYMENT.CAPTURE.COMPLETED`, capture after return | `PAYMENT.CAPTURE.REFUNDED`, `…REVERSED` |
| CCBill | `CCBILL_WEBHOOK_SECRET` | `NewSaleSuccess` (reported price required) | `Refund`, `Void`, `Chargeback` |
| NOWPayments | `NOWPAYMENTS_IPN_SECRET` | `finished`/`confirmed`/`sending` | `refunded` |

Only PowerChat is expected to be enabled in production. A reversal of a purchase claws back the
buyer's remaining credit; credit already given to someone stays with them — their payable is never
touched — and the unrecovered value goes to `chargeback_loss`, flagged `review: required`.
Reversing a subscription payment revokes the periods it granted.

## Operations

- **Reconciliation** (`npm run reconcile`, `GET /api/v1/admin/reconcile`, or the console's
  Reconciliation page) checks: journal zero-sum
  per currency, per-transaction balance, cached balances = entry sums, fx mirror, every settled
  provider event has exactly one transaction, paid cashouts have payout references, payouts_pending =
  requested cashouts. It also lists negative balances, unprocessed/rejected events, items for review
  and import holds; totals exclude test transactions. Runs are stored in `reconciliation_runs`.
- **Freeze** before any risky change: the console's Freeze page, `POST /api/v1/admin/freeze {"on": true, "reason": "…"}`, or on the
  host `node scripts/freeze.js on "<reason>"` (same switch; after `off` the running service processes the
  held webhooks on its next retry tick).
- **Review queue**: chargebacks on donated credit and unattributed site tips appear under
  `warnings` and on the console's Receipts page; resolve them with an adjustment (`relates_to` = the transaction).
- **Payouts** are decided in the staff console (or with `billing.cashout.manage` on the API): pay at the
  provider, then approve with its payout reference once the escrow has ended.
- **Backups**: `sqlite3 /var/lib/openvibe-billing/billing.db ".backup billing-$(date +%F).db"`.

## Cutover runbook (Live → Billing)

The exact production sequence, rollback, grants and the Live behaviour the switch cannot preserve are in
[docs/live-cutover.md](docs/live-cutover.md); the Live side (a `BILLING_AUTHORITY=live|billing` switch,
`live` by default, plus the `money_writes_frozen` freeze) was the patch
[docs/live-patch.diff](docs/live-patch.diff) and is deployed in OpenVibe.Live since `c384787` with the
switch unset. None of the steps below has been executed yet; step 3 needs the owner (PowerChat
dashboard). In short:

1. **Shadow import** as often as needed (`node scripts/import-live.js --live-db <snapshot> [--dry-run]`);
   map held users in the Network and explain every adjustment until reconciliation is clean.
2. **Freeze Live money writes**, wait for in-flight PowerChat checkouts (an hour), back up and **freeze Billing**.
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
§12.12 holds: owning runtime with health/readiness ✔ (`/metrics` not yet); canonical identity and
scoped service principals ✔ (principal `billing`); server-rendered public routes useful without
JavaScript (not yet — the only pages are the staff-only console); real persistence and end-to-end
workflows ✔ in tests, shadow only in production; capability/event registration against
OpenVibe.Contracts ✔ (v0.8.0); migration strategy ✔ (shadow import reconciles; restore drill passed
2026-09-23) with a security review, sitemap/robots still to do; acceptance tests ✔. A shadow deployment
is never counted as the money authority.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
