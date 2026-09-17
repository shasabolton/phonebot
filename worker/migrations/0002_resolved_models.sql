-- Persist Groq model selection once per play session (resolved at session start).
ALTER TABLE play_sessions ADD COLUMN resolved_models_json TEXT;
