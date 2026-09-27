# Autonomous Meeting & Lecture Cognitive Engagement Platform

A privacy-preserving, on-device multimodal AI platform that reads audience attention and confusion in real time — without ever recording, storing, or transmitting video. It runs as a companion tab alongside any meeting platform (Zoom, Google Meet, Teams) or in-person lecture setup.

**Live demo:** `https://lecture-cognitive-engagement-platfo.vercel.app`

---

## What it does

- **For attendees:** opens in a browser tab next to your actual meeting. Your camera feed never leaves your device — only small (~20-byte) numeric telemetry packets are sent, describing attention and confusion levels.
- **For presenters:** a live dashboard showing real-time room-wide attention/confusion, plus a per-slide confusion heatmap built up over the session.
- **For Team Leads:** individual per-attendee engagement reports, end-to-end encrypted with RSA-4096 + AES-256-GCM — the decryption key is generated in the Team Lead's own browser and never touches the server.

---

## Core privacy guarantee

Raw video is processed entirely inside a Web Worker on the attendee's own device using MediaPipe FaceLandmarker and on-device inference. No frame, image, or video data is ever uploaded — only anonymized scalar telemetry (attention score, confusion score, head pose) tagged with a random per-session attendee ID that carries no real identity.

---

## Architecture

```
┌─────────────────────────┐
│   Attendee Browser Tab   │
│  ┌────────────────────┐  │
│  │ Camera → Web Worker │  │   All inference happens here.
│  │ MediaPipe FaceLand- │  │   Video never leaves the device.
│  │ marker + blendshapes│  │
│  └──────────┬───────────┘  │
│             │ ~20-byte binary packet
│             ▼               │
└─────────────WebSocket───────┘
              │
              ▼
┌─────────────────────────────────────┐
│              Express Server           │
│  WebSocket gateway → Redis (live      │
│  sliding-window + per-slide + per-    │
│  attendee aggregates) → Postgres/     │
│  TimescaleDB (durable playback log)   │
└───────────────┬───────────────────────┘
                │
     ┌──────────┼──────────────┐
     ▼          ▼               ▼
Presenter   Session History  Team Lead
Dashboard   (playback)       (RSA-4096 +
(aggregate  bar chart        AES-256-GCM
only)                        encrypted
                              reports)
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js (App Router), TypeScript, Tailwind |
| On-device inference | MediaPipe Tasks Vision (FaceLandmarker), Web Workers, OffscreenCanvas |
| Transport | WebSocket (`ws`), custom 20-byte binary telemetry protocol |
| Live aggregation | Redis (sorted sets for sliding windows, hashes for running per-slide/per-attendee totals) |
| Durable storage | PostgreSQL, with automatic TimescaleDB hypertable support when available |
| Encryption | RSA-4096-OAEP + AES-256-GCM hybrid encryption (Node `crypto` server-side, Web Crypto API client-side) |
| Hosting | Vercel (frontend), Render (backend), Upstash (Redis), Timescale Cloud (Postgres) |

---

## Project structure

```
├── client/                       Next.js frontend
│   ├── app/
│   │   ├── page.tsx               Attendee view
│   │   ├── presenter/page.tsx     Presenter dashboard
│   │   ├── history/page.tsx       Session history + playback
│   │   ├── teamlead/page.tsx      Encrypted per-attendee reports
│   │   ├── components/
│   │   │   └── CameraCapture.tsx  Camera, worker orchestration, telemetry
│   │   ├── workers/
│   │   │   └── frameProcessor.worker.ts   MediaPipe inference, scoring
│   │   └── lib/
│   │       ├── telemetryCodec.ts  Binary packet encode (client side)
│   │       └── reportCrypto.ts    RSA/AES decrypt (client side)
│   └── ...
│
└── server/                       Express backend
    ├── index.js                   HTTP + WebSocket gateway, all routes
    ├── db.js                      Postgres queries
    ├── schema.sql                 DB schema (Timescale-aware)
    ├── telemetryCodec.js          Binary packet decode (server side)
    ├── reportCrypto.js            Hybrid encryption (server side)
    └── *.js (test-*, loadtest*)   Verification scripts for each phase
```

---

## Features by phase

1. **Camera access & scaffolding** — permission handling, live preview
2. **Web Worker + OffscreenCanvas pipeline** — off-main-thread frame processing
3. **Edge inference** — MediaPipe FaceLandmarker, 478 3D landmarks, on-device
4. **Gaze, attention & confusion scoring** — head pose + facial action units (AU4/AU7/AU24) mapped from blendshapes
5. **Telemetry transport** — WebSocket gateway, Redis sliding-window ingestion, custom binary wire format
6. **Presenter dashboard & slide sync** — live room aggregate, per-slide confusion heatmap
7. **Persistence & playback** — PostgreSQL/TimescaleDB, session history, time-bucketed scrubbing view
8. **RBAC & encrypted reports** — RSA-4096 + AES-256-GCM, presenter/Team Lead role separation, per-attendee anonymized IDs
9. **Resilience & hardening** — adaptive FPS throttling, lighting/occlusion detection, permission-revocation handling, WebSocket reconnect with backoff
10. **Polish & deployment** — UI cleanup, full regression testing, production deployment

---

## Running locally

### Prerequisites
- Node.js 18+
- A Redis instance (local or [Upstash](https://upstash.com) free tier)
- A PostgreSQL instance (local or [Timescale Cloud](https://www.timescale.com) free tier)

### Backend
```bash
cd server
npm install
cp .env.example .env    # fill in REDIS_URL and DATABASE_URL
psql <your-connection-string> -f schema.sql
npm run dev
```

### Frontend
```bash
cd client
npm install
npm run dev
```

Open `http://localhost:3000`.

### Verifying the setup
```bash
curl http://localhost:4000/api/health
```
Should return `"redis": "connected"` and `"postgres": "connected"`.

---

## Testing

Each backend phase has an automated verification script:

```bash
cd server
node loadtest.js          # Phase 5: multi-attendee WebSocket + Redis
node loadtest-phase6.js   # Phase 6: slide sync + per-slide aggregation
node test-phase7.js       # Phase 7: persistence + playback
node test-phase8.js       # Phase 8: RBAC + encrypted reports
node test-phase9-math.js  # Phase 9: lighting/occlusion/FPS-throttling math
node test-crypto.js       # RSA-4096 + AES-GCM interop (Node crypto ↔ Web Crypto)
```

All scripts print `✅ PASS` on success. See the full manual testing checklist (camera, lighting, occlusion, reconnect, RBAC boundaries) in the project's testing notes.

---

## Deployment

| Piece | Platform | Notes |
|---|---|---|
| Frontend | Vercel | Root directory: `client`. Env vars: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` (use `wss://` in production) |
| Backend | Render | Root directory: `server`. Build: `npm install`. Start: `npm start`. Env vars: `REDIS_URL`, `DATABASE_URL` |
| Redis | Upstash | Free tier, TLS (`rediss://`) required |
| Postgres | Timescale Cloud | Free tier; schema auto-detects and enables TimescaleDB hypertables when available, falls back to plain PostgreSQL otherwise |

---

## Known limitations

- Slide advancement is manual (presenter clicks Next/Prev) — there's no automatic integration with PowerPoint/Google Slides state.
- The attention/confusion scoring weights are heuristic starting points (calibrated by manual testing), not trained on labeled data.
- Render's free tier cold-starts after ~15 minutes of inactivity — the first request after idle takes 30-60s.
- Presenter dashboard does not auto-reconnect on WebSocket drop (attendee side does, via exponential backoff).

---

## Author

Built by Adi ([@aditya2-code](https://github.com/aditya2-code)) as a portfolio project.
