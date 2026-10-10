# Billing events outbox

Migration `0006_sdk_outbox.sql` expands the database with the openvibe-sdk/events `service_outbox` schema and copies every unsent row from the legacy `outbox`. Billing writes new envelopes to `service_outbox` in the transaction that changes the ledger or operational state. The SDK relay publishes them to OpenVibe.Events with Billing's service token when `EVENTS_URL` and the OAuth client secret are set. Its `status()` reports whether delivery is enabled and the pending and rejected counts.

The legacy table stays for rollback during the N-1 window. A previous release can still read and relay it; Events deduplicates repeated `event_id` values. A later contract migration can drop `outbox` after that window. Check `billing_outbox_pending`, `billing_outbox_failing`, and `billing_outbox_rejected` at `/metrics` when reviewing delivery.
