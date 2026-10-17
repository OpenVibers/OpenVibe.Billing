-- phase: expand
-- Account export and deletion (ADR-033, server/account-data.js): one receipt per export and deletion id, so a
-- redelivered deletion never erases twice and a confirmation Network did not take is sent again (openvibe-sdk/account-data).
CREATE TABLE IF NOT EXISTS account_data_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    outcome JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ
);
