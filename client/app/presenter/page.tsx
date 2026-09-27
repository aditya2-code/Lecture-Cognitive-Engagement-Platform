'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

type Aggregate = {
  sampleCount: number;
  facesPresentCount: number;
  avgAttention: number | null;
  avgConfusion: number | null;
};

type SlideStat = {
  slideIndex: number;
  sampleCount: number;
  avgAttention: number | null;
  avgConfusion: number | null;
};

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000/ws';
const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

function PresenterDashboard() {
  const searchParams = useSearchParams();
  const initialSessionId = searchParams.get('sessionId') || '';

  const [sessionId, setSessionId] = useState(initialSessionId);
  const [connectionState, setConnectionState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const connected = connectionState === 'connected';
  const [slideIndex, setSlideIndex] = useState(0);
  const [aggregate, setAggregate] = useState<Aggregate | null>(null);
  const [slideStats, setSlideStats] = useState<SlideStat[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<number | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);

  const connect = () => {
    if (!sessionId) return;
    setConnectionState('connecting');

    const socket = new WebSocket(`${WS_URL}?sessionId=${sessionId}&role=presenter`);

    connectTimeoutRef.current = window.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.close();
        setConnectionState('error');
      }
    }, 6000);

    socket.onopen = () => {
      if (connectTimeoutRef.current) window.clearTimeout(connectTimeoutRef.current);
      setConnectionState('connected');
    };
    socket.onclose = () => {
      setConnectionState((prev) => (prev === 'connected' ? 'idle' : 'error'));
    };
    socket.onerror = (err) => console.error('WebSocket error:', err);
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'aggregate') {
          setAggregate(msg);
        } else if (msg.type === 'slideChange') {
          setSlideIndex(msg.slideIndex);
        }
      } catch {
        // ignore
      }
    };

    socketRef.current = socket;
  };

  const disconnect = () => {
    socketRef.current?.close();
    socketRef.current = null;
    setConnectionState('idle');
    setAggregate(null);
    setSlideStats([]);
  };

  const changeSlide = (next: number) => {
    const clamped = Math.max(0, next);
    socketRef.current?.send(JSON.stringify({ type: 'setSlide', slideIndex: clamped }));
    setSlideIndex(clamped);
  };

  useEffect(() => {
    if (!connected || !sessionId) return;

    const fetchSlideStats = async () => {
      try {
        const res = await fetch(`${API_URL}/api/sessions/${sessionId}/slides`);
        setSlideStats(await res.json());
      } catch (err) {
        console.error('Failed to fetch slide stats:', err);
      }
    };

    fetchSlideStats();
    pollRef.current = window.setInterval(fetchSlideStats, 3000);

    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [connected, sessionId]);

  useEffect(() => {
    return () => disconnect();
  }, []);

  return (
    <main className="page page--presenter">
      <div className="presenter">
        <div className="presenter__header">
          <div>
            <p className="page__eyebrow">Presenter Dashboard</p>
            <h1 className="page__title presenter__title">
              {connected ? `Session ${sessionId}` : 'Connect to a session'}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 16 }}>
            <Link href="/teamlead" className="page__link">Team Lead</Link>
            <Link href="/history" className="page__link">Session history</Link>
            <Link href="/" className="page__link">← Attendee view</Link>
          </div>
        </div>

        {!connected ? (
          <div className="presenter__connect">
            <label className="page__label" htmlFor="sessionId">
              Session ID
            </label>
            <input
              id="sessionId"
              className="page__input"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value.toUpperCase())}
              placeholder="e.g. ABC123"
            />
            <button className="camera-panel__button" onClick={connect} disabled={!sessionId || connectionState === 'connecting'}>
              {connectionState === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
            {connectionState === 'error' && (
              <p className="page__hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
                Couldn't reach that session. Check the ID and that the server is running.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="presenter__slide-controls">
              <button
                className="camera-panel__button camera-panel__button--secondary"
                onClick={() => changeSlide(slideIndex - 1)}
                disabled={slideIndex === 0}
              >
                ← Prev
              </button>
              <span className="presenter__slide-label">Slide {slideIndex + 1}</span>
              <button
                className="camera-panel__button camera-panel__button--secondary"
                onClick={() => changeSlide(slideIndex + 1)}
              >
                Next →
              </button>
            </div>

            <div className="presenter__live">
              <LiveStat label="Attention" value={aggregate?.avgAttention ?? null} color="var(--signal)" />
              <LiveStat label="Confusion" value={aggregate?.avgConfusion ?? null} color="var(--danger)" />
              <LiveStat
                label="Faces detected"
                value={aggregate?.facesPresentCount ?? null}
                color="var(--text)"
                isCount
              />
            </div>

            <div className="presenter__heatmap">
              <h2 className="presenter__section-title">Confusion by slide</h2>
              {slideStats.length === 0 ? (
                <p className="page__hint">No slide data yet — telemetry will appear once attendees join.</p>
              ) : (
                <div className="heatmap">
                  {slideStats.map((s) => (
                    <div key={s.slideIndex} className="heatmap__row">
                      <span className="heatmap__label">Slide {s.slideIndex + 1}</span>
                      <div className="heatmap__track">
                        <div
                          className="heatmap__fill"
                          style={{
                            width: `${s.avgConfusion ?? 0}%`,
                            background: confusionColor(s.avgConfusion),
                          }}
                        />
                      </div>
                      <span className="heatmap__value">
                        {s.avgConfusion ?? '—'}{s.avgConfusion !== null ? '%' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button className="camera-panel__button camera-panel__button--stop" onClick={disconnect}>
              Disconnect
            </button>
          </>
        )}
      </div>
    </main>
  );
}

function confusionColor(value: number | null): string {
  if (value === null) return 'var(--border)';
  if (value >= 60) return 'var(--danger)';
  if (value >= 30) return '#d9b757';
  return 'var(--signal)';
}

function LiveStat({
  label,
  value,
  color,
  isCount = false,
}: {
  label: string;
  value: number | null;
  color: string;
  isCount?: boolean;
}) {
  return (
    <div className="presenter__live-stat">
      <span className="presenter__live-value" style={{ color }}>
        {value === null ? '—' : `${value}${isCount ? '' : '%'}`}
      </span>
      <span className="presenter__live-label">{label}</span>
    </div>
  );
}

export default function PresenterPage() {
  return (
    <Suspense fallback={null}>
      <PresenterDashboard />
    </Suspense>
  );
}