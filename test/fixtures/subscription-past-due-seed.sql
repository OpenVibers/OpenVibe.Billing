-- PostgreSQL seed for the cutover rehearsal of migrations/0005_subscription_past_due.sql
-- (docs/cutover-pr-openvibe-billing-11.md): two subscriptions as 0001-0004 leave them, so the rehearsal proves
-- the widened subscriptions_status_check accepts every existing row, that no subscription row moves, and that a
-- renewal that fails can now be marked past_due.
INSERT INTO subscriptions (id, subscriber, streamer, tier, provider, provider_ref, route, status, auto_renew, cancel_at_period_end, price_cents, current_period_end, created_at, updated_at) VALUES
    ('sub_01JAB2C3D4E5F6G7H8J9K0SEED1', 'usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'usr_01JAB2C3D4E5F6G7H8J9K0SEEEE', 1, 'powerchat', 'pcsub:seed1', 'site', 'active', 1, 0, 500, '2026-11-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
    ('sub_01JAB2C3D4E5F6G7H8J9K0SEED2', 'usr_01JAB2C3D4E5F6G7H8J9K0SEEDF', 'usr_01JAB2C3D4E5F6G7H8J9K0SEEEE', 2, 'stripe', 'pi_seed2', NULL, 'canceled', 0, 0, 0, '2026-09-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
