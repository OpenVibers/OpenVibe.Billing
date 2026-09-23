# Economic inventory (ADR-012 evidence)

A survey of every economic unit on the OpenVibe network, the class ADR-012 gives it, and the defects
in today's money code that OpenVibe.Billing replaces. References are `file:line` in **OpenVibe.Live**
(branch `seadragon`, commit `c9af780`) unless another repository is named.

Production facts (not re-measured here): card, PayPal and crypto rails are off (`payments_enabled=false`,
`server/monetization/payments.js:26`); only PowerChat carries money, at low volume; almost no balances
are non-zero.

## Units

| Unit | Where it lives | Class | Notes |
|---|---|---|---|
| **Vibes, spendable** | `users.openvibe_bucks_balance REAL` (`server/db/schema.sql:15`) | **CREDIT** | Integer bits since migration `001_vibes_decimal_to_bits` (`server/db/migrations.js:45-68`); 100 bits = $1 of creator value (`server/monetization/vibes.js:17`). Bought at tiered prices with a spread (`vibes.js:33-46`). Spent by donating (`vibes.js:106-140`), subscribing (`payments-routes.js:118-128`) and on media requests (`server/media/media-queue.js:134-144`). |
| **Vibes, cashout** | `users.openvibe_bucks_cashout_balance REAL` (`server/db/database.js:341-344`) | **MONEY** (creator payable) | Only received Vibes land here (`vibes.js:115-117`); cashed out by hand over PayPal (`vibes.js:165-194`); can be recycled back into spendable (`vibes.js:227-248`). |
| **Payment orders** | `payment_orders` (`database.js:1592-1608`) | **MONEY** (provider receipts / intents) | One row per checkout; `status` pending/paid/failed/credited is the only idempotency guard. |
| **Transactions ledger** | `transactions` (`schema.sql:247-261`) | MONEY/CREDIT history | Written after balances move (`database.js:5380-5386`); mutable (`vibes.js:204`, `vibes.js:218`); amounts in bits. |
| **Cashout escrow** | `transactions` rows `type='cashout', status='escrow'` (`vibes.js:178-185`) | **MONEY** | Escrow days are config (`server/config.js:248`) but never enforced at approval (`vibes.js:199-206`); approval records no payout reference. |
| **Subscriptions** | `subscriptions` + extension columns (`schema.sql:234-245`, `database.js:1567-1589`) | **ENTITLEMENT** (+ MONEY for the payment) | Paid from Vibes, Stripe, PayPal, CCBill, crypto or PowerChat; streamer share 70 % (`payments.js:298`) credited to cashout; renewal sweeper (`payments.js:330-364`). |
| **PowerChat direct tips** | streamer's own PowerChat; webhook → goals/alerts only (`server/integrations/powerchat-webhook.js:93-153`) | **EXTERNAL** | Money never touches OpenVibe; direct donate links (`powerchat-checkout.js:239-260`). Direct-route subscriptions (`powerchat-checkout.js:309-311`, `creditShare: false`) are EXTERNAL money + ENTITLEMENT. |
| **PowerChat site-routed tips/purchases** | site PowerChat account; `pcorder:` / `pcsub:` (site) / `pcdon:` refs (`powerchat-checkout.js:267-347`) | **MONEY** | `pcorder` mints spendable Vibes (`:272-287`); `pcsub` site route pays the share (`:289-315`); `pcdon` credits the creator's cashout balance 1 ¢ = 1 bit (`:332-347`). |
| **Donation goals** | `donation_goals` (`schema.sql:264-277`) | display counter | Not a balance: progress bars fed by donations and manual corrections (`vibes.js:147-160`, `:331-340`). Stays in Live/Tips. |
| **OpenCoins** | OpenVibe.Network `coin_transactions` with `idempotency_key TEXT UNIQUE` (Network `server/db/database.js:407-414`) | **LOYALTY** | Earned by activity, never bought; spent on media requests (`media-queue.js:146-157`). User-to-user transfer exists with no caller (Network `server/coins/wallet.js:123`). Live's spend key is `Date.now()`+random (`media-queue.js:151`) — not deterministic. |
| **Channel points** | `channel_points` (`database.js:764-771`), `addChannelPoints`/`deductChannelPoints` (`database.js:4756-4773`) | **LOYALTY** | Per streamer; mutable balance, partial log, no idempotency keys. Spent on rewards and media requests (`media-queue.js:127-133`). |
| **Arena XP / levels** | `server/arena/mic.js:33-34` | **LOYALTY** | Progression only. |
| **Cosmetics** | `user_cosmetics` (`schema.sql:774-783`) | **COSMETIC-ENTITLEMENT** | Unlocks, no balance, not tradable. |
| **Chat tags** | `server/game/tags.js:14-34` | **COSMETIC-ENTITLEMENT** | Granted or bought with legacy in-game gold; not money. |
| **Game caps (Scraplandia)** | OpenVibe.Games (e.g. `apps/client/src/ui/hud.ts:275-286`) | **GAME-STATE** | Items/currency inside the game world; never bridges out (ADR-012 rule 7). |
| **Legacy "gold"** | `users.openvibe_coins_balance` (`schema.sql:16`), frozen per `server/monetization/opencoins.js:12` | **LEGACY-ARCHIVE** | Never written any more; must not be shown as live. |
| **Camp Funds / Hobo Coins / old game** | migrated away (`database.js:325-333`), old game tables (`server/game/schema.sql`) | **LEGACY-ARCHIVE** | Read-only for reconciliation and claims. |

### Rates Live uses today (Billing keeps them as configuration)

| Rate | Value | Source |
|---|---|---|
| Value rate | 100 bits = $1 (`bucks_per_usd`) | `vibes.js:17`, `payments.js:31-34` |
| Purchase tiers | $0.0150/bit (<500) … $0.0110/bit (≥25 000) | `vibes.js:33-46` |
| Minimum purchase | 100 bits | `payments-routes.js:33` |
| Subscription price | $4.99 (`sub_price_usd`) | `payments-routes.js:113` |
| Streamer share | 70 % (`sub_streamer_share_pct`) | `payments.js:298` |
| Site-route fee | 10 % on top (`sub_site_route_fee_pct`) | `payments-routes.js:145-147` |
| Minimum cashout / escrow | 500 bits / 14 days | `config.js:247-248` |

## Defects found

1. **Non-atomic donate.** `donate()` deducts, credits and records in three separate statements with no
   transaction (`vibes.js:111-128`); `deductVibes` is read-then-write (`database.js:5393-5399`), so two
   concurrent donations can both pass the check. A crash between the deduct and the credit loses money.
   *Billing:* every operation is one SQLite transaction with the funds check inside it.
2. **Best-effort, mutable ledger.** The ledger row is written after the balances move and failures are
   swallowed (`payments.js:262-268`, `powerchat-checkout.js:337-343`); rows are later UPDATEd
   (`vibes.js:204`, `:218`); subscription payments and streamer shares write no ledger row at all
   (`payments.js:277-319`); media-request refunds move Vibes with no row (`media-queue.js:489-501`).
   *Billing:* append-only journal (triggers refuse UPDATE/DELETE), every movement is a balanced
   transaction, corrections are reversing transactions.
3. **No unique provider reference.** `payment_orders(provider, provider_ref)` has a plain index
   (`database.js:1607`) and `getPaymentOrderByRef` takes the newest match (`database.js:5429-5432`);
   PowerChat subscription orders even store route markers (`direct:renew`, `site:fee=50`) in
   `provider_ref` (`powerchat-checkout.js:216`, `:224`). *Billing:* `payment_intents` has a unique
   provider ref; every settling transaction carries a unique `receipt_ref`, so one payment settles once.
4. **No refund / chargeback handling.** No provider handler processes refunds, reversals or disputes
   (`payments-routes.js:233-310`, `powerchat-webhook.js:226-256`). *Billing:* each adapter maps them to
   `refund`/`chargeback` transactions with `reverses_txn`; credit already given away stays with its
   recipient and the loss is booked to `chargeback_loss`, flagged for review.
5. **Stripe cancel is not sent to Stripe.** Cancel only flips local flags ("provider stops billing via
   dashboard/API", `payments-routes.js:212-213`); Stripe keeps charging. *Billing:* cancel calls
   Stripe (`cancel_at_period_end=true`) first and changes nothing if Stripe refuses.
6. **Stripe renewals don't credit the creator share.** `invoice.paid` only moves the period end
   (`payments-routes.js:246-253`); the share is credited once, on the first order
   (`payments.js:295-304`). *Billing:* every paid invoice settles a subscription payment with the share.
7. **`recycle` is missing from the transactions CHECK.** The type list is
   `donation|purchase|subscription|cashout|refund|bonus` (`schema.sql:253`), but `recycleCashout` moves
   both balances first and then inserts `type: 'recycle'` (`vibes.js:229-240`) — the insert throws after
   the balances already changed and the route reports an error for a completed move.
8. **PowerChat deliveries are marked seen before processing.** The delivery id is inserted
   (`powerchat-routes.js:454`, `database.js:4887-4891`) and the 200 sent (`:459`) before processing runs
   in `setImmediate` (`:461`), which swallows errors (`powerchat-webhook.js:257-259`). A crash or error
   loses the event while PowerChat considers it delivered; the delivery table is also pruned after
   3 days (`database.js:4892-4895`). *Billing:* the verified payload is stored first and marked
   processed in the same transaction as its effect; failures stay pending and are retried.
9. **User deletion cascades provider receipts.** `payment_orders.user_id REFERENCES users(id) ON DELETE
   CASCADE` (`database.js:1605`) with `foreign_keys = ON` (`database.js:98`): deleting a user erases
   their payment records. *Billing:* receipts are keyed by subject, immutable, and never cascade.

Further observations, fixed or recorded by Billing:

- PowerChat Vibes purchases credit `bucksForUsd(paid)` — the value rate — not the package
  (`powerchat-checkout.js:281`), so PowerChat buyers get no tier spread applied (1 bit per cent paid);
  Billing credits the intent's package when the payment covers it, otherwise what the payment buys
  under the tiers, and records the pricing basis on the transaction.
- Unattributed tips to the site PowerChat account are dropped (`powerchat-webhook.js:193-202`);
  Billing stores them and lists them for review.
- Cancelling a Vibes-paid subscription ends access immediately (`payments-routes.js:213` sets
  `canceled`, and `getActiveSubscription` requires `active`, `database.js:5487-5491`); Billing keeps the
  paid period and ends it at period end.
- Cashout approval neither checks the escrow date nor records a payout reference (`vibes.js:199-206`).
- CCBill's shared secret is compared with `===` (`payments.js:204`); Billing compares in constant time.
