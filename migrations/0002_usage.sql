-- phase: expand
-- Usage readings (platform.usage-sample@1, openvibe-contracts v0.84.0; plan T5 lane F): stored and reported, never
-- charged. A reading's own idempotency_key dedupes retries across every caller; the indexed fields are columns and
-- the whole reading, exactly as accepted, is `reading`. `at` is the reading's time, normalised to UTC milliseconds
-- (the cursor's precision); the original string stays in `reading`. reading_hash is the sha256 of the reading's
-- canonical JSON (sorted keys), compared on a replay. Additive only: no existing table changes.

CREATE TABLE usage_records (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key text COLLATE "C" NOT NULL UNIQUE,
    project text COLLATE "C",
    subject text COLLATE "C",
    service text COLLATE "C" NOT NULL,
    at timestamptz NOT NULL,
    reading jsonb NOT NULL,
    reading_hash text COLLATE "C" NOT NULL,
    principal text COLLATE "C" NOT NULL,
    received_at timestamptz NOT NULL
);

CREATE INDEX usage_records_at ON usage_records (at, id);
CREATE INDEX usage_records_project ON usage_records (project, at, id) WHERE project IS NOT NULL;
CREATE INDEX usage_records_subject ON usage_records (subject, at, id) WHERE subject IS NOT NULL;
CREATE INDEX usage_records_service ON usage_records (service, at, id);
