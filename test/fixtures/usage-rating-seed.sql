-- PostgreSQL seed for the cutover rehearsal of migrations/0004_rating.sql (docs/cutover-usage-rating.md): a ledger as
-- 0001-0003 leave it — one bought-credit purchase, one tip and their accounts — plus one stored usage reading (0002)
-- and one promo allowance (0003), so the rehearsal proves the widened transactions_type_check accepts every existing
-- row, that no ledger row, balance or allowance moves, and that the stored reading gains the new columns unrated.
INSERT INTO accounts (kind, owner_subject, currency, created_at) VALUES
    ('provider_clearing', 'powerchat', 'usd-cents', '2026-10-01T00:00:00.000Z'),
    ('fx_conversion', NULL, 'usd-cents', '2026-10-01T00:00:00.000Z'),
    ('fx_conversion', NULL, 'vibes-bits', '2026-10-01T00:00:00.000Z'),
    ('user_credit', 'usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'vibes-bits', '2026-10-01T00:00:00.000Z'),
    ('creator_payable', 'usr_01JAB2C3D4E5F6G7H8J9K0SEEE', 'vibes-bits', '2026-10-01T00:00:00.000Z');

INSERT INTO transactions (id, type, idempotency_key, from_subject, to_subject, provider, receipt_ref, created_at) VALUES
    ('txn_01JAB2C3D4E5F6G7H8J9K0SEED', 'purchase', 'seed:purchase:1', NULL, 'usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'powerchat', 'powerchat:seed-1', '2026-10-01T00:00:01.000Z'),
    ('txn_01JAB2C3D4E5F6G7H8J9K0SEEE', 'donation', 'seed:donation:1', 'usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'usr_01JAB2C3D4E5F6G7H8J9K0SEEE', NULL, NULL, '2026-10-01T00:00:02.000Z');

INSERT INTO ledger_entries (txn_id, account_id, amount)
SELECT 'txn_01JAB2C3D4E5F6G7H8J9K0SEED', a.id, v.amount FROM (VALUES
    ('provider_clearing', 'powerchat', 'usd-cents', -1000), ('fx_conversion', NULL, 'usd-cents', 1000),
    ('fx_conversion', NULL, 'vibes-bits', -1000), ('user_credit', 'usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'vibes-bits', 1000)
) AS v(kind, owner, currency, amount) JOIN accounts a ON a.kind = v.kind AND a.owner_subject IS NOT DISTINCT FROM v.owner AND a.currency = v.currency;
INSERT INTO ledger_entries (txn_id, account_id, amount)
SELECT 'txn_01JAB2C3D4E5F6G7H8J9K0SEEE', a.id, v.amount FROM (VALUES
    ('user_credit', 'usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'vibes-bits', -400), ('creator_payable', 'usr_01JAB2C3D4E5F6G7H8J9K0SEEE', 'vibes-bits', 400)
) AS v(kind, owner, currency, amount) JOIN accounts a ON a.kind = v.kind AND a.owner_subject IS NOT DISTINCT FROM v.owner AND a.currency = v.currency;

INSERT INTO account_balances (account_id, balance, updated_at)
SELECT a.id, (SELECT COALESCE(SUM(e.amount), 0) FROM ledger_entries e WHERE e.account_id = a.id), '2026-10-01T00:00:02.000Z' FROM accounts a;

INSERT INTO usage_records (idempotency_key, project, subject, service, at, reading, reading_hash, principal, received_at) VALUES
    ('seed:usage:1', NULL, 'user:usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'media', '2026-10-01T00:00:03.000Z',
     '{"id": "use-seed-1", "idempotency_key": "seed:usage:1", "service": "media", "subject": "user:usr_01JAB2C3D4E5F6G7H8J9K0SEED", "provider": "local", "resource": "gib-delivered", "operation": "deliver", "quantity": 1.5, "unit": "GiB", "at": "2026-10-01T00:00:03Z", "source": "media.egress"}',
     'seed', 'svc:media', '2026-10-01T00:00:04.000Z');

INSERT INTO promo_allowances (subject, service, reset_period, granted_bits, window_start, window_end, created_at, updated_at) VALUES
    ('usr_01JAB2C3D4E5F6G7H8J9K0SEED', 'media', 'month', 100, '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-10-01T00:00:05.000Z', '2026-10-01T00:00:05.000Z');
