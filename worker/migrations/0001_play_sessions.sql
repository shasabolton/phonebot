CREATE TABLE IF NOT EXISTS play_sessions (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'paid', 'active', 'paused_for_payment', 'consumed', 'expired'
    )),
    mode_id TEXT NOT NULL,
    robot_slug TEXT NOT NULL,
    owner_id TEXT,
    machine_id TEXT,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    currency TEXT NOT NULL,
    ai_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (ai_budget_cents >= 0),
    ai_spent_cents INTEGER NOT NULL DEFAULT 0 CHECK (ai_spent_cents >= 0),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    consumed_at INTEGER,
    completion_reason TEXT,
    continuation_of TEXT REFERENCES play_sessions(id),
    stripe_checkout_session_id TEXT UNIQUE,
    stripe_payment_intent_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_play_sessions_checkout
    ON play_sessions(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_play_sessions_expiry
    ON play_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
