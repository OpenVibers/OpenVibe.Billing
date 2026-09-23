# OpenVibe.Live → OpenVibe.Billing: what maps where

Where every piece of Live's money state goes in Billing, as the importer
([server/importer/live.js](../server/importer/live.js), `node scripts/import-live.js --live-db <snapshot>`) and
the cutover ([live-cutover.md](live-cutover.md)) implement it. The audit found this was never written down,
in particular for **payouts, refunds and plans**. **Live has no table for any of those three.** They live
inside other rows, and this page says which ones.

Counts are from production `/opt/openvibe.live/data/live.db`, read on 2026-09-23. The importer opens a
**snapshot copy** read-only and never writes Live. Every write it makes is keyed, so a re-run over the same
snapshot changes nothing.

## Balances: `users`

| Live | Billing | How |
|---|---|---|
| `users.openvibe_bucks_balance` (spendable Vibes) | `user_credit:<subject>` (vibes-bits, CREDIT) | Step 4 (opening): the imported part of the account is set equal to the column. The difference from the replayed history goes to `import_adjustment` and is listed in the report. |
| `users.openvibe_bucks_cashout_balance` (creator earnings) | `creator_payable:<subject>` (vibes-bits, MONEY) | Same as above. |
| the Live user id | the Network subject `usr_…` | Step 1: `resolve-batch` (system `live`). A user with no subject is **held**: their accounts sit under `hold:live:<id>` and appear in `import_holds`. A later run moves them once the Network knows the user. |
| `users.openvibe_coins_balance`, `channel_points`, `coin_transactions` | not Billing | OpenCoins and channel points are LOYALTY (ADR-012 rules 5–8). |

Fractional column values are rounded and reported as `fractional_balance` anomalies.

## Vibes history: `transactions`

Every row becomes one journal transaction with type `import`, status `imported` and key
`import:live:txn:<id>`. Rows dated before `site_settings.stats_vibes_reset_at` are flagged `test`. A row
that moved no balance still gets a transaction, with no entries and the reason in `metadata.note`.

| Live `type` / `status` | Billing entries | Notes |
|---|---|---|
| `purchase` / `completed` | `provider_clearing:live-legacy` → fx → `user_credit:<to>` | The provider receipt, if there was one, comes from `payment_orders` (below). |
| `donation` / `completed`, from a user | `user_credit:<from>` → `creator_payable:<to>` | Includes Vibes-paid media requests (`message` "Media request: …"). |
| `donation` / `completed`, no sender | `provider_clearing:live-legacy` → fx → `creator_payable:<to>` | Site-routed PowerChat tips ("PowerChat tip via site account"). |
| `subscription` / `completed` | not replayable: recorded with no entries (`unreplayable`) | The balance effect reaches Billing through the opening balances. The subscription itself comes from `subscriptions`. |
| `cashout` / `escrow` | `creator_payable` → `payouts_pending` + a `cashouts` row `requested` | See **Payouts**. |
| `cashout` / `completed` | `creator_payable` → fx → `provider_clearing:paypal_payouts` + a `cashouts` row `paid` | See **Payouts**. |
| `cashout` / `refunded` | no entries (requested and returned) + a `cashouts` row `denied` | See **Payouts**. |
| `refund` / `completed` | `creator_payable:<from>` → `user_credit:<to>` | See **Refunds**. |
| `bonus` / `completed` | `platform_revenue` (bits) → `user_credit:<to>` | |
| any `pending` / `failed` | no entries (`status …: no balance moved`) | |

Production on 2026-09-23 has 304 rows: 176 `purchase` and 128 `donation`, all `completed`. There are no
`cashout`, `refund`, `bonus` or `subscription` rows.

## Payouts: no table on Live

On Live, a payout is a `transactions` row with `type = 'cashout'` plus the move from
`openvibe_bucks_cashout_balance`. In Billing it is a `cashouts` row plus its journal entries. Billing
decides new payouts in the staff console.

| Live | Billing `cashouts` |
|---|---|
| the row id | `legacy_live_txn` (UNIQUE: imported once) |
| `from_user_id` | `subject` (or `hold:live:<id>` until mapped) |
| `amount` | `amount_bits`; `value_cents` = the value at the recorded rate |
| `status` `escrow` / `completed` / `refunded` | `requested` / `paid` / `denied` |
| `created_at` | `created_at`; `escrow_until` = `created_at` + `BILLING_ESCROW_DAYS` (Live's `ESCROW_HOLD_DAYS`, 14) |
| `message` ("Cashout to PayPal: …") | `payout_method` `{ type: 'paypal', legacy_message }` |
| — | `request_txn` / `settle_txn` = the imported transaction |
| `paypal_transaction_id` | **not carried.** A `paid` import gets `payout_reference = live-import:unrecorded:<id>` and a `paid_cashout_without_provider_reference` anomaly. Only Live's unmounted `community-funds.js` ever wrote the column, and 0 of the 304 production rows have it. |

`MIN_CASHOUT_BUCKS` (500) maps to `BILLING_MIN_CASHOUT_BITS`. Live's `min_cashout_amount` site setting
(also 500) is not read by Live's cashout code.

## Refunds: no table on Live

| Live | Billing |
|---|---|
| `transactions` `type = 'refund'` (a creator gives Vibes back) | an imported transaction `creator_payable` → `user_credit` |
| `transactions` `cashout` / `refunded` (a denied cashout) | a `cashouts` row `denied`, nets to nothing |
| a Vibes media-request refund (`media-queue.js`: balances move, **no row**) | nothing replayable. The effect shows up in the opening-balance adjustment. After the cutover Live calls `POST /api/v1/transfers/:id/refund`. A request charged before the cutover and refunded after it is refunded by an operator adjustment (live-cutover.md, "What the switch does not preserve" 11). |
| provider refunds and chargebacks | none: Live handled none. Billing books them as `refund` / `chargeback` transactions with `reverses_txn` (server/ops/reversals.js). |
| `payment_orders.status` | has no refunded state. An intent becomes `refunded` in Billing only after a Billing reversal. |

## Plans: no table on Live

Live sells one channel subscription per (subscriber, streamer) at a site-wide price. There is no plan row.
The "plan" is made of settings plus the `subscriptions.tier` column:

| Live | Billing / elsewhere |
|---|---|
| `site_settings.sub_price_usd` (4.99) | `BILLING_SUB_PRICE_CENTS` (499) |
| `site_settings.sub_streamer_share_pct` (70) | `BILLING_SUB_SHARE_PCT` |
| `site_settings.sub_site_route_fee_pct` (10) | `BILLING_SITE_ROUTE_FEE_PCT` |
| the period (a month) | `BILLING_SUB_PERIOD_DAYS` (31) |
| `subscriptions.tier` (1–3, always 1 in practice) | `subscriptions.tier` |
| what a subscriber gets (badge, perks) and the plan as a product | **OpenVibe.VIP** `vip_plans` / `vip_plan_versions` (VIP's own Live import creates plan `channel-subscription` per creator). VIP never prices anything; the price is Billing's. |

Each transaction records the rates it used (`metadata.rates`), so a later change of these settings does not
rewrite history.

## Subscriptions: `subscriptions`

Step 5, keyed by `legacy_live_id`: each row becomes a Billing `subscriptions` row, plus one `entitlements`
row for the current paid period.

| Live | Billing |
|---|---|
| `subscriber_id`, `streamer_id` | `subscriber`, `streamer` (subjects). The row is skipped (reported) while either is unmapped. |
| `status`, `is_active`, `current_period_end` / `expires_at` | `status` `active` / `canceled` / `expired`; `current_period_end` |
| `provider` (`bucks` → `credit`), `provider_ref`, `price_cents`, `auto_renew`, `cancel_at_period_end` | the same fields |
| the paid period | an `entitlements` row (`channel_subscription`, scope = streamer). A later snapshot that extends it adds one. |

Production has 0 rows.

## Checkouts: `payment_orders`

Step 2, keyed by `legacy_order_id`: every order becomes a `payment_intents` row. A `credited` or `paid`
order also becomes an immutable `provider_events` receipt (`live-order:<id>`, effect `imported`).

| Live | Billing |
|---|---|
| `status` `credited` / `failed` / `pending` / `paid` | intent `settled` (settled **in Live**: no `settled_txn`, so a later delivery is refused, never credited twice) / `failed` / `created` or `expired` if older than 3 days / `created` + an `order_paid_not_credited` anomaly |
| `kind` `bucks` / `subscription` | `kind` `purchase` / `subscription` |
| `provider_ref` `direct[:renew]`, `site[:fee=N][:renew]` (PowerChat route markers) | `route`, `fee_cents`, `auto_renew`. `provider_ref` becomes NULL. For `direct`, `metadata.receiving_account` is taken from `powerchat_connections`. |
| any other duplicate `provider_ref` | kept on the first order, reported in `duplicate_provider_refs` |
| `amount_cents`, `bucks`, `user_id`, `streamer_id` | `amount_cents`, `bits`, `subject`, `streamer_subject` |

A later run follows orders Live credited or failed after the earlier run. Production has 5 orders.

## PowerChat: `powerchat_connections` and the webhook

| Live | Billing |
|---|---|
| `powerchat_connections` (`user_id`, `powerchat_username`, `powerchat_user_id`) | Step 6: `provider_accounts` (provider `powerchat`, lower-case username, account id → subject, source `live-import`). An EXTERNAL tip on that account is announced for that creator (server/ops/external.js). An operator mapping (source `admin`) is never overwritten. `--accounts-only` runs this step alone. Production has 2 connections, both with an account id. |
| the same table, for a direct subscription | the intent's `receiving_account` (see above) |
| `powerchat_webhook_deliveries` (delivery-id dedupe) | not imported. Billing dedupes on `provider_events (provider, provider_event_id)`. |
| `site_settings.powerchat_webhook_secret`, `powerchat_site_tip_username`, `powerchat_allow_test_fulfillment` | `POWERCHAT_WEBHOOK_SECRET`, `POWERCHAT_SITE_USERNAME`, `POWERCHAT_ALLOW_TEST_FULFILLMENT` |
| Live's webhook celebrating a tip on the streamer's own PowerChat (chat line, sound, goal) | `external_receipts` plus `billing.receipt.external` under `BILLING_AUTHORITY=billing`. OpenVibe.Tips celebrates it. |

## Prices and rates

| Live | Billing |
|---|---|
| `site_settings.bucks_per_usd` (100) | `BILLING_BITS_PER_USD` |
| `site_settings.bucks_min_purchase_bucks` (100) | `BILLING_MIN_PURCHASE_BITS` |
| `BUCKS_PRICE_TIERS` (constant in `server/monetization/vibes.js`) | `BILLING_PRICE_TIERS` (the same values by default) |
| `site_settings.stats_vibes_reset_at` | the importer's `test` cut-off |
| `site_settings.payments_enabled` (false) | nothing. Live keeps it as an extra gate for card rails. Billing enables a provider only when its secrets are set. |

## Not imported, on purpose

| Live | Why / where it goes |
|---|---|
| `donation_goals` | OpenVibe.Tips (`tip_goals`, via Tips' own Live import; `current_amount` carried over as `opening_amount`) |
| `media_requests` (queue, `cost`) | Live's queue. The Vibes charge is a `donation` above. Tips holds paid media requests after the cutover. |
| `billing_actions` | Live's own journal of calls it made to Billing (created on first use; it does not exist on production yet) |
| `coin_transactions`, `channel_points`, `arena_tier_paid` | LOYALTY. `arena_tier_paid` records which arena tier-up OpenCoins rewards were paid. It is no longer used by Live's code. |
| chat `donation` messages | history only. Tips imports the PowerChat ones as EXTERNAL interactions. |
