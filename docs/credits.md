# Credits: the prepaid USD balance for metered services

OpenVibe has two currencies (AI Exchange D9, owner 2026-11-03):

| Currency | For | Precision |
|---|---|---|
| **Vibes** | Social and consumer use: tips and bits on Live, creators, cashout, consumer apps priced in whole Vibes. | A whole Vibes bit, 100 per USD. |
| **Credits** | A traditional topped-up balance that metered developer and platform services spend: the AI API first, then compute. | nano-USD (1e-9 USD) |

Nothing about Vibes changes. Credits are built on the same double-entry journal, in their own currency (`nano-usd`)
and their own accounts, and they never go through `chargeFor`.

Everything is behind `BILLING_CREDITS` (off). Sandbox grants are also behind `BILLING_CREDITS_SANDBOX` (off).

**Sandbox credit is kept apart (D10).**
- A grant lands in the person's own `usd_credit_sandbox` account for that project, never in `usd_credit`.
- Only a hold with `sandbox: true` spends it, and a real hold never sees it: granted test credit can never pay for
  real supply.
- A sandbox charge returns to the sandbox issuer, not to `platform_revenue`, and its journal transaction is marked
  test.
- The statement shows the sandbox balance apart (`sandbox`).

Every internal request body is checked against its `openvibe-contracts` schema first; another shape is a 422
`billing.invalid_request`, before anything is held.

## How a request is paid

1. **Hold.** The service (OpenVibe AI) asks for a hold of the worst case before it does anything paid, with
   `POST /internal/credits/holds` and `{ idempotency_key, subject, project_id, service, max_nano_usd, rate_version,
   request_fingerprint, sandbox? }`.
   - The account row is locked (`FOR UPDATE`), and the hold is created only if `available = balance − active holds`
     covers it. Otherwise the answer is 402 and nothing runs.
2. **Extend.** While a stream grows, the service extends the hold in steps (`/holds/:id/extend`), each one checked the
   same way.
3. **Settle, once.** At the end the service sends the four token counts, the retail card it used (version and rates),
   the supply cost, `byok` and the attempts (`/holds/:id/settle`).
   - Billing computes the charge itself: for each token class, `ceil(tokens × rate_nano_per_m / 1,000,000)`, plus the
     per-request fee.
   - It moves that amount from the person's `usd_credit` account to `platform_revenue` (a sandbox hold: from their
     `usd_credit_sandbox` back to the issuer), and releases the rest of the hold.
   - In the same transaction it announces `billing.credit.settled@1`, for aggregates (OpenVibe.Report). The event
     carries the answering deployment, its `provider_access`, the four token counts, what was collected, the supply
     cost and the shortfall. It never carries the subject, the project or the account: a person's charges are read
     from their statement.
4. **Release.** A request that never ran releases its hold with nothing charged (`/holds/:id/release`). A hold that is
   forgotten is released by the lease sweeper.

## The invariants, and the tests that hold them (`test/credits.test.js`)

| Invariant | How it is kept | Test |
|---|---|---|
| **No overspend.** Holds plus charges never exceed the funded balance, under any concurrency. | Every hold, extend and settle locks the account row and re-reads `available` inside the transaction. | 100 concurrent holds on a balance that fits 7: exactly 7 succeed, the balance is untouched, the holds sum to the balance. |
| **Exactly one charge per request.** | The settle's idempotency key is unique. A replay returns the first settlement. Two concurrent settles serialize on the hold lock, and the second replays. A key reused for another hold is a 409. | settle replay: one journal transaction, the same settlement. |
| **One hold per key.** | The key is unique and re-checked after the account lock. The same key with another fingerprint is a 409. | idempotent create; 409 on a fingerprint change. |
| **Only what was used is charged.** | The settle computes the charge from usage and releases the rest. An aborted stream settles its partial usage. | an aborted stream: a partial charge, the rest released. |
| **No silent loss.** | Usage beyond the hold is taken from the free balance. What cannot be collected (never below zero) is recorded as `shortfall_nano_usd` for reconciliation. | usage beyond the hold: the free balance is taken, the shortfall recorded, the balance never below zero. |
| **Sandbox credit never pays for real supply.** | A grant credits `usd_credit_sandbox`; only a `sandbox: true` hold draws on it, and its charge goes back to the issuer. | a real hold on granted credit is 402; a sandbox hold settles, `platform_revenue` unchanged. |
| **BYOK is never billed twice.** | `byok: true` charges 0; the provider bills the person directly. | BYOK settle: charge 0. |
| **The journal balances.** | Every movement is a balanced journal entry, in its own currency. Reconciliation sums per currency as text, so no total exceeds JavaScript's safe range. | the journal balances at the end. |
| **Rounding is once per token class per request.** | `computeCharge`. | the 4-class rounding test, with a worked example. |

**The old amplification, gone.** `chargeFor` rounds every usage reading up to one whole Vibes bit ($0.01). One token at
$1 per billion tokens is charged a full cent there, a ten-million-fold over-charge. Credits charge it 1 nano-USD.
(test: "the old chargeFor amplification for tiny usage does not affect the subledger")

## Reading it

A signed-in person reads their own statement for a project with `GET /api/me/credits?project_id=prj_…`:
- the balance, what is held and what is available;
- the last 50 charges: service, model, token counts, charge, shortfall, BYOK, rate version.

There is never any prompt or answer: Billing never receives them.

## Launch runbook (each step needs the owner's go-ahead)

1. **Canary.** In a staging copy: `BILLING_CREDITS=1` and `BILLING_CREDITS_SANDBOX=1`.
   - Fund a staff account with a test top-up booked straight through the ledger (a one-off script, the way
     `fund()` in `test/credits.test.js` books one; sandbox grants cannot pay real holds). Then run OpenVibe AI with
     `AI_CREDITS=1` against an own-deployment model, and settle about a hundred requests.
   - The reconciliation job must report zero problems (`journal.zero_sum`, no negative `usd_credit`, no unbalanced
     transaction).
2. **Production, dark.**
   - Deploy with `BILLING_CREDITS=0`. Migration `0011` is expand-only: it widens three checks (added `NOT VALID`, then
     validated) and adds new tables.
   - Turn the flag on for staff projects only. Funding is still off, so real balances are zero: staff try the flow
     with sandbox tokens on sandbox credit, which pays for nothing real.
3. **Funding.** Add the checkout top-up into `usd_credit`; this is a separate change, and the owner sets the prices
   and terms.
4. **Kill switch.** `BILLING_CREDITS=0` refuses every hold (503). OpenVibe AI then refuses paid requests with a clear
   error, while BYOK, the person's own machine and sandbox keep working. `money_writes_frozen` freezes the whole
   economy, Credits included.
5. **Rollback.** Turn the flag off. The tables stay, unused: N-1 code never reads them.
6. **Reconcile daily.**
   - The reconciliation job covers `nano-usd` like every other currency.
   - Shortfalls are listed for review, never written off silently.
