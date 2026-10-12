-- How each model did in its tests, so a model joining a shortlist takes its place by performance:
-- models that answer straight away first, then the quickest.
ALTER TABLE telnyx_chat_models ADD COLUMN reply_ms INTEGER;
ALTER TABLE telnyx_chat_models ADD COLUMN reasons INTEGER NOT NULL DEFAULT 0;
