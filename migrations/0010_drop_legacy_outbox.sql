-- phase: contract
-- after: 0006
-- The SDK outbox (service_outbox, migration 0006, 2026-10-10) has carried every Billing event since. The legacy outbox
-- was empty, and since Billing#90 (deployed 2026-10-23, this release's N-1) no code reads it.
DROP TABLE IF EXISTS outbox;
