-- Cognitive Engagement Platform — Phase 7 schema
-- Uses TimescaleDB when available, falls back to plain PostgreSQL otherwise.

CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  attendee_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS telemetry_events (
  time          TIMESTAMPTZ NOT NULL,
  session_id    TEXT NOT NULL,
  slide_index   INTEGER NOT NULL DEFAULT 0,
  face_detected BOOLEAN NOT NULL,
  attention     SMALLINT,
  confusion     SMALLINT,
  head_yaw      SMALLINT,
  head_pitch    SMALLINT
);

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('telemetry_events', 'time', if_not_exists => TRUE);
    RAISE NOTICE 'TimescaleDB hypertable created.';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'TimescaleDB not available — using plain PostgreSQL table.';
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_telemetry_session_time
  ON telemetry_events (session_id, time);