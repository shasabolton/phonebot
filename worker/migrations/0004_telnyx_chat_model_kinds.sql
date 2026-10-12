-- Separate shortlists for text turns and photo (camera) turns: one row per model per kind, so a
-- model can be on both. Existing rows are the text list.
CREATE TABLE telnyx_chat_models_by_kind (
    id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'photo')),
    status TEXT NOT NULL CHECK (status IN ('shortlist', 'reserve', 'rejected')),
    rank INTEGER NOT NULL DEFAULT 0,
    -- Temporary failures (timeouts, server errors) on different days; two reject the model.
    strikes INTEGER NOT NULL DEFAULT 0,
    strike_at INTEGER,
    last_ok_at INTEGER,
    -- A live turn failed on this model since it last worked: test it after the next turn.
    last_failed_at INTEGER,
    -- Claimed by the turn testing it, so two turns never test the same model at once.
    testing_until INTEGER,
    note TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, kind)
);

INSERT INTO telnyx_chat_models_by_kind
    (id, kind, status, rank, strikes, strike_at, last_ok_at, last_failed_at, testing_until, note, updated_at)
SELECT id, 'text', status, rank, strikes, strike_at, last_ok_at, last_failed_at, NULL, note, updated_at
FROM telnyx_chat_models;

DROP TABLE telnyx_chat_models;
ALTER TABLE telnyx_chat_models_by_kind RENAME TO telnyx_chat_models;
