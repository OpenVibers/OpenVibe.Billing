-- phase: expand
-- openvibe-sdk/events owns service_outbox. Copy pending legacy events before the new relay starts.
-- A later contract migration drops outbox after the N-1 rollback window.

CREATE TABLE IF NOT EXISTS service_outbox (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id        text NOT NULL UNIQUE,
    envelope        jsonb NOT NULL,
    traceparent     text,
    created_at      bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at bigint NOT NULL DEFAULT 0,
    sent_at         bigint,
    seq             bigint,
    rejected_at     bigint,
    last_error      text
);
CREATE INDEX IF NOT EXISTS service_outbox_due ON service_outbox (next_attempt_at, id) WHERE sent_at IS NULL AND rejected_at IS NULL;
CREATE INDEX IF NOT EXISTS service_outbox_sent ON service_outbox (sent_at) WHERE sent_at IS NOT NULL;

INSERT INTO service_outbox (event_id, envelope, created_at, attempts)
SELECT event_id, event::jsonb, (EXTRACT(EPOCH FROM created_at::timestamptz) * 1000)::bigint, attempts
FROM outbox WHERE sent_at IS NULL ON CONFLICT (event_id) DO NOTHING;
