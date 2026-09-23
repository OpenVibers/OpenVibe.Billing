# Live → Billing cutover

**Status:** prepared, **not executed**. OpenVibe.Live stays the money authority until someone runs
the sequence below. Binding decision: [ADR-012](https://github.com/OpenVibers/OpenVibe.Contracts/blob/main/docs/adr/ADR-012-economic-classification.md).

The Live side is the patch [`live-patch.diff`](live-patch.diff), made against OpenVibe.Live branch
`seadragon` at `e032d78` and `git apply --check` clean on `9f4f1da` (that commit only touches the nginx
config). It adds a switch that is **off by
default**: applied and deployed with `BILLING_AUTHORITY` unset, Live behaves exactly as before.

## What the patch does

| | `BILLING_AUTHORITY` unset / `live` (default) | `BILLING_AUTHORITY=billing` |
|---|---|---|
| Buy Vibes | Live `payment_orders` + provider checkout | `POST /api/v1/intents` (kind purchase); for PowerChat, Live mints the tip link with Billing's `checkout_ref` (`pcorder:pi_…`) |
| PayPal return | Live captures + credits | `POST /api/v1/intents/:id/capture` |
| Donation / tip | Live columns + `transactions` | `POST /api/v1/transfers` (kind `donation`, target = the Live stream) |
| Vibes-paid media request / its refund | donation on Live columns / manual unwind | `POST /api/v1/transfers` (kind `paid_interaction`) / `POST /api/v1/transfers/:id/refund` |
| Cashout request / recycle | Live columns | `POST /api/v1/cashouts` / `POST /api/v1/recycle` |
| Cashout approve / deny / pending list (owner) | Live | **409** — decided in Billing's **staff console** (`https://billing.openvibe.network/cashouts`; payout reference required, escrow enforced; ADR-012 rule 10) |
| Subscribe with Vibes | Live columns + `subscriptions` | entitlement check, then `POST /api/v1/subscriptions` (source `credit`) |
| Subscribe via PowerChat / Stripe | Live order + link | `POST /api/v1/intents` (kind subscription, route `site`/`direct`; `direct` also needs `receiving_account` = the streamer's PowerChat username from `powerchat_connections`) |
| Cancel, "my subscriptions", channel "subscribed?" + count | Live `subscriptions` | Billing subscriptions/entitlements (cancel keeps the paid period) |
| Balance, history | Live columns / `transactions` | `GET /api/v1/balances/:subject`, `GET /api/v1/transactions`; **unavailable** (503) when Billing does not answer — never the legacy column |
| Subscriber perks (PowerChat overlay sub badge, AI "subscriber" flag) | `subscriptions` row | Billing entitlement, cached 60 s (served stale at most 10 min while refreshing; unknown = not a subscriber) |
| PowerChat webhook `/api/powerchat/webhook`, card webhooks `/api/payments/webhook/*` | processed on Live | **410** with Billing's webhook URL in the body |
| Renewal sweep, PowerChat paid-messages reconciler | run on Live | not started (Billing renews; Billing receives the webhooks) |
| Live money columns and tables | written | **never written**: `users.openvibe_bucks_balance`, `openvibe_bucks_cashout_balance`, `transactions`, `payment_orders`, `subscriptions` are legacy read-only (a tripwire in `database.js` throws on any write) |

- **One place:** `server/monetization/money-authority.js` reads `BILLING_AUTHORITY`; any value other
  than `live`/`billing` refuses every money write.
- **Client:** `server/monetization/billing-client.js` — service token for audience
  `openvibe.billing` (client `live`), traceparent, timeouts (`OV_BILLING_TIMEOUT_MS`, 8 s writes / 4 s
  reads), problem+json mapped to Live's `{ error }` shapes. No fallback to Live's columns.
- **Idempotency:** every POST carries a key derived once per Live action and journaled in Live's
  `billing_actions` table before the call: `live:<action>:<uuid>`, `live:<action>:u<user>:c<key>` when
  the browser sends an `Idempotency-Key`, or a natural key (`live:media_refund:<request id>`,
  `live:paypal_capture:<intent id>`, `live:sub_cancel:<sub id>:<period end>`). A retry re-sends the same
  key and body. (The brief's example `live:donation:<chat message id>` is not used: the donation chat
  line is written only after Billing confirms, so it cannot key the call.)
- **Failures:** Billing unreachable → 503 `billing_unavailable` ("nothing was charged"); a write that
  may have reached Billing but got no answer → 504 `billing_outcome_unknown`, journaled as `unknown`
  and listed at `GET /api/admin/money`; the owner resolves it with
  `POST /api/admin/money/actions/:id/resolve` (same key: Billing replays the original result, or
  applies it now if it never arrived). A missing Network grant → 503 `billing_misconfigured`.
- **Subjects:** a person is `usr_…` from identity-sync `subjectOf()` (the subject the Network put in
  their token), else Network's identity map (`/internal/identity/resolve-batch`, the same map this
  service's importer used). Neither → 409 `no_subject`; the integer Live id is never sent.
- **Freeze:** `money_writes_frozen` (owner-only site setting; `GET /api/admin/money` for every admin,
  `POST /api/admin/money/freeze {on, reason}` owner only) refuses, in both modes, every money action a
  person or operator starts on Live: checkouts, donations, Vibes media requests and their refunds,
  cashout request/approve/deny, recycle, subscribe, cancel, and the renewal sweep. Reads keep working.
  In `live` mode, provider confirmations of checkouts started **before** the freeze still settle (the
  provider already took that money; refusing it would drop a real payment).

## Before the day

1. **Billing** runs this repository at the commit that carries this document (it includes the
   cutover guards: an order Live already credited is never settled again, a later import never
   adjusts away Billing's own movements, `scripts/freeze.js`). `/etc/openvibe/billing.env`:
   - `POWERCHAT_WEBHOOK_SECRET` = the PowerChat app's webhook signing secret (the value Live has in the
     `powerchat_webhook_secret` setting — the webhook is only re-pointed, not re-created);
   - `POWERCHAT_SITE_USERNAME` = Live's `powerchat_site_tip_username`;
   - `POWERCHAT_ALLOW_TEST_FULFILLMENT` off; `BILLING_*` rates equal to Live's settings
     (`bucks_per_usd`, `bucks_min_purchase_bucks`, `sub_price_usd`, `sub_streamer_share_pct`,
     `sub_site_route_fee_pct`, `MIN_CASHOUT_BUCKS`, `ESCROW_HOLD_DAYS`) — Live shows its own prices, Billing
     charges its own, so they must match (`GET /api/admin/money` lists any drift once the switch is on).
2. **Network grants** for Live's client (`live`):

   | client | capability | audience |
   |---|---|---|
   | live | billing.intent.create | openvibe.billing |
   | live | billing.transfer.create | openvibe.billing |
   | live | billing.balance.read | openvibe.billing |
   | live | billing.cashout.request | openvibe.billing |
   | live | billing.subscription.manage | openvibe.billing |
   | live | billing.entitlement.check | openvibe.billing |
   | live | identity.subject.resolve | openvibe.network (already used by Live's paste client) |

   Live is deliberately **not** granted `billing.cashout.manage` or `billing.ledger.admin`.
   Those are held only by people, through Billing's staff console (below).
3. **Staff console** (it replaces Live's cashout admin — without it nobody can approve a payout after
   the switch):
   - **Network:** OAuth client `billing` (today a service client with no redirect URI) gets the redirect
     URI `https://billing.openvibe.network/auth/callback` — add
     `{ client_id: 'billing', name: 'OpenVibe.Billing', redirect_uris: ['https://billing.openvibe.network/auth/callback'] }`
     to the seeded `contractClients` in OpenVibe.Network `server/db/database.js` (it only adds the URI to the
     existing client) and deploy the Network. The Network already supports PKCE S256.
   - **`/etc/openvibe/billing.env`:** `BILLING_STAFF_SUBJECTS` = the `usr_…` subjects of the people who
     decide payouts (each must also have role `admin` on the Network); `BILLING_SESSION_SECRET` = 32+
     random characters (`openssl rand -hex 32`). Restart Billing.
   - **nginx:** install the updated [deploy/nginx/billing.openvibe.network.conf](../deploy/nginx/billing.openvibe.network.conf)
     (console proxied, `/api/v1` denied on the public host, `/webhooks/*` public) and reload.
   - **Check:** sign in at `https://billing.openvibe.network/`, open Cashouts, run a reconciliation from the
     dashboard; the Audit log shows the sign-in and the run. Someone not listed gets 403.
4. **Live** has the patch applied and deployed with `BILLING_AUTHORITY` unset (no behaviour change;
   `GET /api/admin/money` answers `authority: "live"`).
5. **Identity:** Live's daily legacy-map sync (`identity-legacy-sync`) has run since the last
   sign-ups (restart Live or wait a day), and Live's log has no `[Identity] live user N is mapped to …`
   conflict for a user who holds money. A shadow import against a fresh snapshot shows **no import
   holds** for users with a non-zero balance (a held user's Vibes sit on `hold:live:<id>` and would read
   as 0 under their subject until a later import releases them) and every adjustment is explained.

Shell helpers used below (on the host):

```bash
# billing '<command>' runs one command with Billing's environment, as Billing's service user (ubuntu)
# so the database files keep their owner — the same way the shadow imports were run.
billing() { sudo bash -c "set -a; . /etc/openvibe/billing.env; set +a; export NODE_ENV=production BILLING_DB_PATH=/var/lib/openvibe-billing/billing.db; cd /opt/openvibe.billing && sudo -E -u ubuntu $1"; }
LIVE_DB=/opt/openvibe.live/data/live.db
```

Live owner calls are made from the browser console on openvibe.live, signed in as the owner:
`await api('/admin/money')`, `await api('/admin/money/freeze', { method: 'POST', body: { on: true, reason: '…' } })`.

## The sequence

0. **Check who is live**: `curl -s https://openvibe.live/api/streams` — the deploy in step 6 restarts
   Live (RTMP/WHIP sessions reconnect); pick a quiet moment.
1. **Freeze Live money writes** (runbook step 3): `api('/admin/money/freeze', { method: 'POST', body: { on: true, reason: 'Billing cutover' } })`;
   `api('/admin/money')` → `frozen: true`. New checkouts, donations, cashouts, subscriptions stop.
2. **Let in-flight checkouts land** on Live: wait at least **60 minutes** after step 1 (minted PowerChat
   checkout links live one hour), then run the backfill once: `api('/powerchat/reconcile', { method: 'POST' })`.
   Look at what is still open:
   `sqlite3 "$LIVE_DB" "SELECT id, provider, kind, amount_cents, status, created_at FROM payment_orders WHERE status IN ('pending','paid') AND created_at >= datetime('now','-3 days')"`.
   A `paid` row is an anomaly to fix first; a `pending` one is carried into Billing as an intent and
   settles there if it is ever paid (canonical, un-minted links do not expire).
3. **Back up and freeze Billing** so it holds PowerChat deliveries until the final import is in:
   `billing "sqlite3 /var/lib/openvibe-billing/billing.db '.backup /var/lib/openvibe-billing/billing-pre-cutover.db'"`
   (kept for rollback), then `billing "node scripts/freeze.js on 'Live cutover'"` → `frozen: true`.
4. **Re-point the PowerChat webhook** (manual, PowerChat developer dashboard for OpenVibe.Live's app):
   `https://openvibe.live/api/powerchat/webhook` → **`https://billing.openvibe.network/webhooks/powerchat`**,
   same signing secret. From this moment every delivery is stored (202) and held by Billing; Live gets none.
   `billing 'node scripts/freeze.js status'` shows `held_webhooks` growing only if tips arrive.
5. **Final snapshot and import** (after step 4, so every delivery either reached Live before the snapshot
   or is held by Billing):
   ```bash
   SNAP=/var/backups/openvibe/live-cutover-$(date +%F-%H%M).db      # keep this file (rollback)
   sudo mkdir -p /var/backups/openvibe && sudo sqlite3 "$LIVE_DB" ".backup $SNAP" && sudo chown ubuntu "$SNAP" && sudo chmod 600 "$SNAP"
   billing "node scripts/import-live.js --live-db $SNAP --dry-run"
   billing "node scripts/import-live.js --live-db $SNAP"
   billing 'node scripts/reconcile.js'
   ```
   Read the report: `holds` (must be empty for anyone with money), `adjustments`, `anomalies`,
   `intents_updated` (orders Live credited since the shadow import). Reconciliation must print **OK**.
6. **Switch Live**: add to `/etc/openvibe/live.env`
   ```
   BILLING_AUTHORITY=billing
   OV_BILLING_INTERNAL_URL=http://127.0.0.1:4600
   OV_BILLING_PUBLIC_URL=https://billing.openvibe.network
   ```
   then `sudo /opt/openvibe.live/deploy/scripts/deploy.sh --wait-idle` (an env change needs the
   restart; the systemd socket keeps accepting while it boots). Wait for `GET /api/ready`.
   `api('/admin/money')` → `authority: "billing"`, `billing.reachable: true`, `billing.rates.drift: []`.
7. **Unfreeze Billing**: `billing 'node scripts/freeze.js off'`. Within a minute the service processes the
   held deliveries in arrival order: a checkout Live never credited settles once; a delivery for an order
   Live already credited is **rejected** (`billing.intent_settled_in_live`) and listed for review — never
   credited twice. `billing 'node scripts/reconcile.js'` → OK; read its `rejected events` line.
8. **Verify the reads** (Live still frozen): as the owner, `api('/funds/balance')` equals your Billing
   balance and your frozen Live column; spot-check a streamer's `cashout_balance` the same way.
   `api('/admin/money')` → `billing.actions.attention: []`. In the staff console, Cashouts lists the
   imported open cashouts (pending, with their escrow dates) and Receipts lists any held delivery Billing
   rejected as already credited by Live.
9. **Unfreeze Live**: `api('/admin/money/freeze', { method: 'POST', body: { on: false } })`.
10. **Verify with a small real PowerChat purchase**: Buy Vibes on openvibe.live with PowerChat (100 Vibes).
    After the tip: one new settled `powerchat` provider event in Billing, the balance rises by 100 once,
    `billing 'node scripts/reconcile.js'` is OK, and Live's legacy columns did not move. If anything is off,
    freeze Live and Billing again and roll back.

**Why this order differs from the brief** (freeze → final import → reconcile → switch → deploy → verify →
re-point → unfreeze): the verification purchase cannot work before the re-point (its webhook would reach
Live, which answers 410 under `billing` — and a 410 makes PowerChat disable the endpoint, per Live's
`powerchat-reconcile.js`), nor while Live is frozen (the checkout is refused). Re-pointing *before* the final
snapshot, with Billing frozen across the switch, is what guarantees that every PowerChat delivery lands in
exactly one of the two: Live before the snapshot, or Billing's held queue after it.

## Rollback

Keep the step-5 snapshot. The Billing side never needs undoing to roll Live back; the question is only
which money moved where.

- **Before step 6** (Live still on its own columns): re-point the PowerChat webhook back to
  `https://openvibe.live/api/powerchat/webhook`; leave Billing **frozen** (its held deliveries are
  not processed, and must not be until a fresh final import); unfreeze Live. Payments whose webhook went to Billing in the window are still pending
  orders on Live and are backfilled by Live's paid-messages reconciler (every 15 min, or
  `api('/powerchat/reconcile', { method: 'POST' })`). Before a later attempt, run a fresh final import
  before unfreezing Billing (the guards then reject the held deliveries Live has since credited).
- **After step 6, before step 9** (Live frozen; only held stragglers settled in Billing): remove
  `BILLING_AUTHORITY` from `/etc/openvibe/live.env`, deploy with `--wait-idle`, re-point PowerChat to
  Live, unfreeze Live. The stragglers Billing settled are still pending orders on Live and are
  backfilled by Live's reconciler from PowerChat's paid-messages feed — so Billing must forget them:
  stop `openvibe-billing`, restore `billing-pre-cutover.db` from step 3 over `billing.db` (remove the
  `-wal`/`-shm` files), freeze it (`billing "node scripts/freeze.js on 'rollback'"`), start it again.
  Otherwise a later attempt would count those payments twice (Live's credit arrives through the import,
  Billing's own settlement stays).
- **After step 9** (people have moved money in Billing): ADR-012's rollback — freeze Billing and Live,
  re-derive Live's columns from Billing's journal. **No tool for that exists yet.** By hand: for each
  subject, `users.openvibe_bucks_balance` = Billing `credit`, `openvibe_bucks_cashout_balance` = `payable`,
  open cashouts re-created as Live `escrow` rows, and Billing subscriptions/entitlements created after the
  cutover have no Live row. This is manual and lossy for history; prefer fixing forward.

## What the switch does not preserve

Said plainly, for whoever runs this and for Wave 9 (Tips) / Wave 10 (VIP):

1. **Everything else that arrived on Live's PowerChat webhook stops once it points at Billing.** Tips
   on a streamer's own PowerChat (EXTERNAL money) no longer post Live's donation chat line and global
   mirror, play the donation sound, or advance the streamer's Live donation goal; PowerChat
   follow/host/channel-points/subscription notices no longer appear in Live chat. PowerChat has one
   webhook URL per app. Billing stores these deliveries (EXTERNAL, no liability) but nothing forwards
   them to Live; that needs an Events consumer (Billing's outbox emits `billing.*` when `EVENTS_URL` is
   set) or the Tips service.
2. **Live no longer learns about PowerChat settlements:** no "Vibes credited" / "Subscribed!"
   notification to the buyer, no sub alert forwarded to the streamer's PowerChat overlay for
   PowerChat-paid subscriptions (Vibes-paid ones still get it), no celebration for legacy site-routed
   `pcdon:` tips.
3. **Cashout decisions leave Live's admin:** approve, deny and the pending list answer 409 on Live.
   They move to Billing's staff console (`https://billing.openvibe.network/cashouts`, Network admins listed
   in `BILLING_STAFF_SUBJECTS`): approving needs the provider payout reference and is refused before the
   escrow ends; denying needs a reason; each decision is in the staff audit log. Live's 409 message still
   points at "its operator API" — updating that wording to name the console is a Live-side change.
4. **Displays that read Live's `transactions` table freeze at the cutover:** the stream donation
   leaderboard, stream recap tip totals, VOD tip counts and the home "Vibes tipped"/"supporters" stats
   stop counting new tips (admin money totals are blanked rather than shown stale).
5. **Renewal notices** ("could not auto-renew", "subscription has ended") came from Live's sweeper;
   Billing's sweep renews and expires but notifies nobody.
6. **Cancelling a Vibes-paid subscription** used to end access at once on Live; Billing keeps the paid
   period and ends it at period end.
7. **Subscriber perks can lag by up to a minute** (entitlement cache; the first check of a pair
   answers "not a subscriber" while it fetches).
8. **An "unknown" outcome that the owner resolves** re-sends the same request: if Billing never got the
   first attempt, the action (e.g. a donation the viewer was told may not have gone through) happens then.
9. **The SPA does not send an `Idempotency-Key` yet**, so a double-clicked donation is still two
   donations (as today); the server honours the header when a client sends it.
10. **Card rails** additionally stay behind Live's `payments_enabled` switch (off in production), on top
    of Billing's own provider enablement.
11. **A Vibes media request charged before the cutover and refunded after it is not refunded
    automatically**: its charge is imported Live history, not a Billing transfer Live can reverse. Live
    logs the skip; an operator refunds it with a Billing adjustment (`creator_payable` → `user_credit`).

What does carry over unchanged under `billing`: Live's donation chat line, global mirror, alert sound,
donation goals and the PowerChat overlay tip for on-site Vibes donations (all Live-side displays, driven
after Billing confirms the transfer), and the sub alert for Vibes-paid subscriptions.

## How the patch was tested

In a scratch copy of Live at `e032d78` with the patch applied, on Node 22.22.1: `npm test` → **60/60 test
files** (57 existing, unchanged, plus 3 new; the home-page size budgets included):

- `test/billing-switch-off.test.js` — unset switch: donate, cashout, approve, balance, recycle,
  subscribe, cancel move Live's columns exactly as before; a running Billing stand-in receives **zero**
  calls; no `billing_actions` table appears; the PowerChat receiver still runs.
- `test/billing-authority.test.js` — `billing`: each action calls Billing with the right capability,
  a `live:<action>:…` key and `usr_` subjects (never Live ids); browser-key replay is one donation;
  refusals map to Live's messages; no subject → 409 with no Billing call; balance/history/subscriptions/
  entitlements read Billing; PowerChat and card webhooks answer 410 with Billing's URL; a missing grant →
  503; a timeout → 504 `unknown`, resolved by the owner with the same key (Billing replays); Billing down →
  503 and "unavailable" reads; the `database.js` tripwire; and Live's money columns and tables are
  unchanged at the end.
- `test/money-freeze.test.js` — owner-only freeze visible to admins; every write refused in both modes
  (zero Billing calls while frozen), reads served, the renewal sweep paused, a pre-freeze checkout still
  settles, a Vibes media refund deferred (not marked refunded); a `BILLING_AUTHORITY` typo refuses writes.

It was also run against the **real** Billing app (this repository's test harness, stub Network): donate,
balance, history, recycle, cashout, subscribe, cancel, entitlement, PowerChat checkout settled through
Billing's webhook, media charge + refund — Billing reconciled OK and Live's columns stayed untouched.
Working out this sequence turned up two Billing defects, fixed alongside with `test/cutover.test.js`:
a PowerChat delivery for an order Live had already credited would have been credited a second time
(imported intents carried no settlement, and a re-import did not follow orders Live credited after the
shadow import), and a re-run of the import after Billing had settled anything itself would have booked
an opening-balance adjustment reversing it.
