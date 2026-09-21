# OpenVibe.Billing

> The isolated money ledger: providers, receipts, subscriptions, entitlements, refunds and payouts.

**Status:** placeholder — planning only, no runnable code yet.  
**Domain:** `billing.openvibe.network`  
**Plan:** OpenVibe End-to-End Realignment & Implementation Plan, revision 3 (20 Sep 2026), §11.1, §11.4, §11.5.  
**License:** AGPL-3.0 (same as every OpenVibe service).

## Purpose

One append-only, balanced ledger for every monetary flow on the network, kept strictly separate from loyalty points (channel points, OpenCoins) and from every product UI. Provider webhooks land here and nowhere else.

## Owns

- `accounts`, `ledger_entries`, `transactions`, `provider_events`, `payment_intents`, `payouts`, `refunds`, `subscriptions`, `plans`, `entitlements`, `reconciliation_runs`, `idempotency_keys`
- immutable provider receipts and idempotent settlement
- operational freeze/reconciliation controls

## Does not own

- tip/creator UX (OpenVibe.Tips)
- membership plan/perk presentation (OpenVibe.VIP)
- loyalty/channel-point semantics

## Planned surfaces

- ledger and provider adapters; subscription lifecycle; entitlement queries and projections
- operator reconciliation and receipt history

## Data (authority tables / families)

- see above

## Capabilities and events

- `billing.intent.create`, `billing.subscription.*`, `billing.entitlement.check`

Events: ``billing.transaction.settled|refunded``, ``billing.subscription.*``, ``billing.entitlement.granted|revoked``

## Depends on

- OpenVibe.Contracts
- OpenVibe.Events
- OpenVibe.Network

## Acceptance (must be true before "done")

- a duplicated provider webhook produces exactly one accounting effect
- refund/reversal traces to the original transaction
- loyalty balances can never be withdrawn or mistaken for money
- entitlement truth is queryable with Live offline

## Bootstrap / extraction source

Network's OpenCoins wallet and Live's Vibes/PayPal/subscription logic after every economic unit has been classified (ADR-012).

## Launch rule

This repository does not make the product real, and the domain keeps its placeholder page on
[OpenVibers/OpenVibe.Sites](https://github.com/OpenVibers/OpenVibe.Sites) until all of the
following exist here (plan §12.12):

1. an owning runtime with health/readiness endpoints and observability;
2. canonical identity/auth integration (OpenVibe.Network subjects, scoped service principals);
3. server-rendered or static public routes that are useful without JavaScript;
4. real persistence and end-to-end workflows;
5. capability and event registration against `OpenVibe.Contracts`;
6. a migration/seed strategy, a security/threat review, and sitemap/robots/feed behaviour;
7. acceptance tests proving the advertised functionality.

The launch release removes the domain from `OpenVibe.Sites/sites.json`, switches routing and
registers maturity in the ecosystem registry atomically. A placeholder is never counted as an
implemented service.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).
