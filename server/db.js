const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cognitive_engagement';

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err);
});

async function ensureSession(sessionId) {
  await pool.query(
    `INSERT INTO sessions (session_id) VALUES ($1)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId]
  );
}

async function endSession(sessionId) {
  await pool.query(
    `UPDATE sessions SET ended_at = now() WHERE session_id = $1`,
    [sessionId]
  );
}

async function insertTelemetryEvent(sessionId, telemetry) {
  await pool.query(
    `INSERT INTO telemetry_events
       (time, session_id, slide_index, face_detected, attention, confusion, head_yaw, head_pitch)
     VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8)`,
    [
      telemetry.timestamp,
      sessionId,
      telemetry.slideIndex ?? 0,
      telemetry.faceDetected,
      telemetry.faceDetected ? telemetry.attention : null,
      telemetry.faceDetected ? telemetry.confusion : null,
      telemetry.headYaw,
      telemetry.headPitch,
    ]
  );
}

async function listSessions() {
  const { rows } = await pool.query(
    `SELECT
       s.session_id,
       s.started_at,
       s.ended_at,
       COUNT(t.time) AS sample_count,
       ROUND(AVG(t.attention)) AS avg_attention,
       ROUND(AVG(t.confusion)) AS avg_confusion
     FROM sessions s
     LEFT JOIN telemetry_events t ON t.session_id = s.session_id AND t.face_detected
     GROUP BY s.session_id, s.started_at, s.ended_at
     ORDER BY s.started_at DESC
     LIMIT 50`
  );
  return rows;
}

async function getPlaybackSeries(sessionId, bucketSeconds = 5) {
  const { rows } = await pool.query(
    `SELECT
       to_timestamp(floor(extract(epoch FROM time) / $2) * $2) AS bucket,
       ROUND(AVG(attention)) AS avg_attention,
       ROUND(AVG(confusion)) AS avg_confusion,
       COUNT(*) FILTER (WHERE face_detected) AS sample_count
     FROM telemetry_events
     WHERE session_id = $1
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [sessionId, bucketSeconds]
  );
  return rows;
}

module.exports = { pool, ensureSession, endSession, insertTelemetryEvent, listSessions, getPlaybackSeries };