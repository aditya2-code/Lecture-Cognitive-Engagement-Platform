require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');
const { decodeTelemetry, PACKET_SIZE } = require('./telemetryCodec');
const { hybridEncrypt } = require('./reportCrypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const WINDOW_MS = 30_000;
const SESSION_TTL_SECONDS = 3600;

app.use(cors());
app.use(express.json());
app.disable('etag');

const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('Redis error:', err));

const teamLeadPublicKeys = new Map();

app.get('/api/health', async (req, res) => {
  const redisOk = redis.status === 'ready';
  let postgresOk = false;
  try {
    await db.pool.query('SELECT 1');
    postgresOk = true;
  } catch {
    postgresOk = false;
  }

  res.json({
    status: 'ok',
    service: 'cognitive-engagement-platform-server',
    redis: redisOk ? 'connected' : redis.status,
    postgres: postgresOk ? 'connected' : 'unreachable',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/sessions/:sessionId/aggregate', async (req, res) => {
  try {
    res.json(await computeAggregate(req.params.sessionId));
  } catch (err) {
    console.error('Aggregate fetch failed:', err);
    res.status(500).json({ error: 'Failed to compute aggregate' });
  }
});

app.get('/api/sessions/:sessionId/slides', async (req, res) => {
  try {
    res.json(await computeSlideStats(req.params.sessionId));
  } catch (err) {
    console.error('Slide stats fetch failed:', err);
    res.status(500).json({ error: 'Failed to compute slide stats' });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    res.json(await db.listSessions());
  } catch (err) {
    console.error('Session list fetch failed:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

app.get('/api/sessions/:sessionId/playback', async (req, res) => {
  try {
    const bucketSeconds = parseInt(req.query.bucketSeconds, 10) || 5;
    res.json(await db.getPlaybackSeries(req.params.sessionId, bucketSeconds));
  } catch (err) {
    console.error('Playback fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch playback series' });
  }
});

app.post('/api/sessions/:sessionId/end', async (req, res) => {
  try {
    await db.endSession(req.params.sessionId);
    res.json({ ok: true });
  } catch (err) {
    console.error('End session failed:', err);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

app.post('/api/sessions/:sessionId/team-lead-key', (req, res) => {
  const { publicKeySpki } = req.body;
  if (!publicKeySpki || typeof publicKeySpki !== 'string') {
    return res.status(400).json({ error: 'publicKeySpki (base64 SPKI) is required' });
  }
  teamLeadPublicKeys.set(req.params.sessionId, publicKeySpki);
  res.json({ ok: true });
});

app.get('/api/sessions/:sessionId/reports', async (req, res) => {
  const sessionId = req.params.sessionId;
  const publicKeySpki = teamLeadPublicKeys.get(sessionId);

  if (!publicKeySpki) {
    return res.status(403).json({
      error: 'No verified Team Lead key registered for this session. Register one first.',
    });
  }

  try {
    const attendeeIds = await redis.smembers(`session:${sessionId}:attendees`);

    const reports = await Promise.all(
      attendeeIds.map(async (attendeeId) => {
        const statsKey = `session:${sessionId}:attendee:${attendeeId}:stats`;
        const stats = await redis.hgetall(statsKey);
        const count = parseInt(stats.count || '0', 10);

        const report = {
          attendeeId,
          sampleCount: count,
          avgAttention: count ? Math.round(parseFloat(stats.attentionSum) / count) : null,
          avgConfusion: count ? Math.round(parseFloat(stats.confusionSum) / count) : null,
        };

        return { attendeeId, encrypted: hybridEncrypt(publicKeySpki, report) };
      })
    );

    res.json(reports);
  } catch (err) {
    console.error('Report generation failed:', err);
    res.status(500).json({ error: 'Failed to generate reports' });
  }
});

async function computeAggregate(sessionId) {
  const key = `session:${sessionId}:telemetry`;
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  await redis.zremrangebyscore(key, '-inf', windowStart);
  const entries = await redis.zrangebyscore(key, windowStart, '+inf');

  if (entries.length === 0) {
    return { sessionId, sampleCount: 0, avgAttention: null, avgConfusion: null, windowMs: WINDOW_MS };
  }

  const parsed = entries.map((e) => JSON.parse(e));
  const facesPresent = parsed.filter((p) => p.faceDetected);

  const avgAttention = facesPresent.length
    ? Math.round(facesPresent.reduce((sum, p) => sum + p.attention, 0) / facesPresent.length)
    : null;
  const avgConfusion = facesPresent.length
    ? Math.round(facesPresent.reduce((sum, p) => sum + p.confusion, 0) / facesPresent.length)
    : null;

  return { sessionId, sampleCount: parsed.length, facesPresentCount: facesPresent.length, avgAttention, avgConfusion, windowMs: WINDOW_MS };
}

async function computeSlideStats(sessionId) {
  const slidesKey = `session:${sessionId}:slides`;
  const slideIndices = await redis.smembers(slidesKey);

  const results = await Promise.all(
    slideIndices.map(async (slideIndex) => {
      const statsKey = `session:${sessionId}:slide:${slideIndex}:stats`;
      const stats = await redis.hgetall(statsKey);
      const count = parseInt(stats.count || '0', 10);

      return {
        slideIndex: parseInt(slideIndex, 10),
        sampleCount: count,
        avgAttention: count ? Math.round(parseFloat(stats.attentionSum) / count) : null,
        avgConfusion: count ? Math.round(parseFloat(stats.confusionSum) / count) : null,
      };
    })
  );

  return results.sort((a, b) => a.slideIndex - b.slideIndex);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const presenterSubscribers = new Map();
const attendeeSubscribers = new Map();
const currentSlideBySession = new Map();

wss.on('connection', (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const role = url.searchParams.get('role') || 'attendee';

  if (!sessionId) {
    socket.close(4000, 'sessionId is required');
    return;
  }

  if (role === 'presenter') {
    addSubscriber(presenterSubscribers, sessionId, socket);
    socket.send(JSON.stringify({ type: 'slideChange', slideIndex: currentSlideBySession.get(sessionId) ?? 0 }));

    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'setSlide' && typeof msg.slideIndex === 'number') {
          currentSlideBySession.set(sessionId, msg.slideIndex);
          broadcastSlideChange(sessionId, msg.slideIndex);
        }
      } catch (err) {
        console.error('Failed to parse presenter message:', err);
      }
    });

    socket.on('close', () => {
      presenterSubscribers.get(sessionId)?.delete(socket);
    });
    return;
  }

  const attendeeId = url.searchParams.get('attendeeId') || crypto.randomUUID();

  db.ensureSession(sessionId).catch((err) => console.error('ensureSession failed:', err));
  redis
    .sadd(`session:${sessionId}:attendees`, attendeeId)
    .then(() => redis.expire(`session:${sessionId}:attendees`, SESSION_TTL_SECONDS))
    .catch((err) => console.error('Failed to register attendee:', err));

  addSubscriber(attendeeSubscribers, sessionId, socket);
  socket.send(JSON.stringify({ type: 'slideChange', slideIndex: currentSlideBySession.get(sessionId) ?? 0 }));

  socket.on('message', async (data, isBinary) => {
    if (!isBinary || data.length !== PACKET_SIZE) return;

    try {
      const telemetry = decodeTelemetry(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      await ingestTelemetry(sessionId, attendeeId, telemetry);
      broadcastAggregateToPresenters(sessionId);
    } catch (err) {
      console.error('Failed to process telemetry packet:', err);
    }
  });

  socket.on('close', () => {
    attendeeSubscribers.get(sessionId)?.delete(socket);
  });
});

function addSubscriber(map, sessionId, socket) {
  if (!map.has(sessionId)) map.set(sessionId, new Set());
  map.get(sessionId).add(socket);
}

function broadcastSlideChange(sessionId, slideIndex) {
  const payload = JSON.stringify({ type: 'slideChange', slideIndex });
  for (const socket of attendeeSubscribers.get(sessionId) ?? []) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
  for (const socket of presenterSubscribers.get(sessionId) ?? []) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

async function ingestTelemetry(sessionId, attendeeId, telemetry) {
  const key = `session:${sessionId}:telemetry`;

  await redis.zadd(key, telemetry.timestamp, JSON.stringify(telemetry));
  await redis.expire(key, SESSION_TTL_SECONDS);

  if (telemetry.faceDetected) {
    const slideIndex = telemetry.slideIndex ?? 0;
    const slideStatsKey = `session:${sessionId}:slide:${slideIndex}:stats`;
    const slidesKey = `session:${sessionId}:slides`;

    await redis.sadd(slidesKey, slideIndex);
    await redis.hincrbyfloat(slideStatsKey, 'attentionSum', telemetry.attention);
    await redis.hincrbyfloat(slideStatsKey, 'confusionSum', telemetry.confusion);
    await redis.hincrby(slideStatsKey, 'count', 1);
    await redis.expire(slideStatsKey, SESSION_TTL_SECONDS);
    await redis.expire(slidesKey, SESSION_TTL_SECONDS);

    const attendeeStatsKey = `session:${sessionId}:attendee:${attendeeId}:stats`;
    await redis.hincrbyfloat(attendeeStatsKey, 'attentionSum', telemetry.attention);
    await redis.hincrbyfloat(attendeeStatsKey, 'confusionSum', telemetry.confusion);
    await redis.hincrby(attendeeStatsKey, 'count', 1);
    await redis.expire(attendeeStatsKey, SESSION_TTL_SECONDS);
  }

  db.insertTelemetryEvent(sessionId, telemetry).catch((err) =>
    console.error('Failed to persist telemetry event:', err)
  );
}

async function broadcastAggregateToPresenters(sessionId) {
  const subscribers = presenterSubscribers.get(sessionId);
  if (!subscribers || subscribers.size === 0) return;

  const aggregate = await computeAggregate(sessionId);
  const payload = JSON.stringify({ type: 'aggregate', ...aggregate });

  for (const socket of subscribers) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`WebSocket gateway on ws://localhost:${PORT}/ws`);
});