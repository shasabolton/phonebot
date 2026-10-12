-- Tested Telnyx chat models (see worker/src/telnyxChatModels.js). Filled by
-- scripts/updateTelnyxChatModels.mjs, then kept current by one background test after Telnyx turns.
--   shortlist: tried in `rank` order on every turn
--   reserve:   passed (or not yet tested); the next one replaces a shortlisted model that fails
--   rejected:  failed; `note` says why. Tried again after a few months.
CREATE TABLE IF NOT EXISTS telnyx_chat_models (
    id TEXT PRIMARY KEY,
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
    updated_at INTEGER NOT NULL
);
