# Vibes Pay: sell things for Vibes

Vibes Pay (D12 step 4) lets any OpenVibe app sell an item for whole Vibes, on its own site or inside
OpenVibe. Billing moves the Vibes once from the person to the app's project; the app learns by a signed
webhook and by `GET /api/v1/vibes/charges/:id`.

Money is whole Vibes (integers). A charge is never priced in Balance, cents or nano-USD.

## The app's routes

An app authenticates with its own Network app token (capability `billing.vibes.charge`), never with a
service token. The token names the app, its project and its environment (`production` or `sandbox`).

```
POST /api/v1/vibes/charges
{ "amount": 50, "description": "Sticker pack: Neon cats", "reference": "order_123",
  "return_url": "https://myapp.example/thanks" }
→ { "id": "vch_…", "pay_url": "https://openvibe.network/pay/vch_…", "status": "pending",
    "expires_at": "…", … }                                         201 (200 on a replay)

GET  /api/v1/vibes/charges/:id          the charge, as billing.vibes-charge@1 (the app's own only)
POST /api/v1/vibes/charges/:id/refund   { "reason": "…" } → the refunded charge; once
```

`reference` is the app's idempotency key: the same reference and body returns the same charge, a different
body is `409 billing.reference_reused`. A charge expires 30 minutes after creation
(`BILLING_VIBES_CHARGE_TTL_SECONDS`, 1–86 400).

The app's webhook settings are its own, in Billing's D11 store (a `billing.app.<app_id>` namespace; the
secret is a secret-class value sealed with the service's KEK when one is configured):

```
GET    /api/v1/vibes/webhook            → { url, secret_set, secret_hint, sealed, … }
PUT    /api/v1/vibes/webhook            { url, secret?, rotate_secret? }
                                        → the settings; a generated secret is returned once
DELETE /api/v1/vibes/webhook            → { configured: false }
```

The webhook URL is https in production and must name a public address; deliveries are checked against the
egress guard and do not follow redirects.

## The person's routes

Signed in with their own account token; the same CORS and `Cache-Control: private, no-store` as
`/api/me/vibes`.

```
GET  /api/me/vibes/charges/:id     the pay sheet: charge, app { id, name, icon }, vibes_credit,
                                   shortfall_vibes, can_pay, expired, daily_remaining_vibes
POST /api/me/vibes/charges/:id/pay     { idempotency_key } → { charge, vibes_credit } (200)
POST /api/me/vibes/charges/:id/cancel  → { charge }
```

The person's Vibes never go below zero. Short of Vibes is `402 billing.insufficient_vibes` with
`available` and `required`; the sheet offers "Get Vibes". A paid charge cannot be paid again: the same
person gets a replay (and one journal transaction), another person gets `409 billing.charge_not_pending`.
An expired charge is `409 billing.charge_expired`. A double refund returns the same refunded charge.

The app's name and icon come from Network's app registry (`GET /internal/projects/:project_id`, the
`dev_apps` entry). When Billing's service token cannot read that project view, the charge still answers:
the app id is shown and Network's pay sheet fills the name from its own `dev_apps` row.

## The project's wallet and cashout

Paid Vibes land in **`project_payable`, owner `project:<prj_id>`** — a kind of its own, not
`creator_payable`, because its owner is a project: a personal cashout, a tip refund or an account export
must never touch a project's money.

The project's owner cashes it out through the existing cashout path:
`POST /api/v1/cashouts { subject, amount, payout_method, project_id }` with `billing.cashout.request`.
Billing checks with Network that the person is the project's **owner**, spends `project_payable`, and the
normal escrow, approve and deny rules apply. A deny returns the Vibes to the owner's `creator_payable`
(payouts are for the owner).

## Webhooks

Each paid or refunded charge queues one row in `vibes_webhook_outbox` in the same transaction as the
money. The delivery is:

```
POST <the app's webhook url>
Content-Type: application/json
X-OpenVibe-Signature-V2: t=<unix seconds>,v2=<hex HMAC-SHA256 of "<t>.<raw body>">
X-OpenVibe-Timestamp: <unix seconds>
X-OpenVibe-Delivery-Id: <stable across retries>
X-OpenVibe-Delivery-Attempt: <1, 2, …>
X-OpenVibe-Event: billing.vibes.charge.paid | billing.vibes.charge.refunded
```

The body is `billing.vibes.charge.paid@1` or `billing.vibes.charge.refunded@1`. It carries the charge
fields, `status`, the whole `amount`, `sandbox` and an opaque `payer_ref` that is random and stable per
(app, person). It never carries a person id, username or email. A 2xx is delivered; anything else is
retried after 15 s, 30 s, 1 min, 2 min, 5 min, 15 min, 1 h and 6 h, then abandoned. Every attempt signs
again with a fresh `t`; `openvibe-sdk` v0.84.0 verifies the header with
`webhooks.verify(rawBody, signature, secret)` against the raw body and the ±300 s window.

The same payload is published to OpenVibe.Events as `billing.vibes.charge.paid` / `.refunded`, so
first-party products can consume it without a webhook.

## Sandbox

A sandbox app (`env: sandbox` in its app token) charges **sandbox Vibes only**, worth nothing. Its test
grant route mints them for a person for that app:

```
POST /api/v1/vibes/sandbox/grants   { "subject": { "type": "user", "id": "usr_…" }, "amount": 500 }
```

Sandbox payments move `vibes_credit_sandbox` → `project_payable_sandbox`, and their journal transaction
is marked test. They never read or write a real Vibes account, never count toward the real daily limit,
and are available only while `BILLING_VIBES_SANDBOX=1`. A sandbox app cannot read real Vibes through
`GET /api/v1/vibes/me`.

For a sandbox app to get an app token for this audience, Network must list `openvibe.billing` in
`DEV_SANDBOX_AUDIENCES` (a Network production setting, the same requirement AI's sandbox has). Its
`billing.vibes.charge` grant is approved inside the project's allowance as usual.

## Limits and the frozen economy

The owner sets these in the `billing.vibes` namespace (D11; env pins win while set):

| Key | What it does |
|---|---|
| `vibes_pay` | On/off for real app charges. Off is `403 billing.vibes_pay_disabled`. |
| `max_charge_vibes` | The largest single real charge. 0 closes new charges. |
| `daily_app_spend_vibes_per_person` | The most one person may pay in apps in a day (paid charges in the last 24 h). 0 closes spending. |

A refusal is `403 billing.vibes_limit_exceeded` with the limit and the amount in `details`. Sandbox charges
have no owner limit; they move test Vibes only. Every write (create, pay, refund, cancel, sandbox grant,
webhook setting) is refused with `503 billing.frozen` while the economy is frozen; reads keep working.

Real payments also require `BILLING_AUTHORITY=billing`: while Live is the authority, a real pay or refund
answers `409 billing.not_authoritative`, because Billing's Vibes numbers are a shadow then.

## Environment

- `BILLING_VIBES_PAY`, `BILLING_VIBES_MAX_CHARGE`, `BILLING_VIBES_DAILY_APP_SPEND` — the pre-D11 names of the
  `billing.vibes` keys (still env pins while set).
- `BILLING_VIBES_SANDBOX=1` — sandbox test grants and charges.
- `BILLING_VIBES_CHARGE_TTL_SECONDS` — charge lifetime (default 1800; 1–86 400).
- `BILLING_VIBES_PAY_BASE_URL` — the pay-sheet origin (default `https://openvibe.network`).
- `BILLING_VIBES_WEBHOOK_INTERVAL_MS` — the delivery job interval (default 5000; 0 disables the timer; tests
  call `deliverDue` directly).
- `BILLING_VIBES_ALLOW_PRIVATE_WEBHOOKS=1` — development only: allow a private webhook address. Production
  always applies the egress guard.
