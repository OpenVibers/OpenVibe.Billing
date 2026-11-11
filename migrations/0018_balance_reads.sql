-- phase: expand
-- Ask 273: the person's own read state for "what changed in my balances since I last looked".
-- One row per person per currency: the transaction id cursor the bar has already shown.
CREATE TABLE balance_reads (
    subject text COLLATE "C" NOT NULL,
    currency text COLLATE "C" NOT NULL CHECK (currency IN ('vibes')),
    last_seen_txn text COLLATE "C" NOT NULL REFERENCES transactions (id),
    updated_at text COLLATE "C" NOT NULL,
    PRIMARY KEY (subject, currency)
);
