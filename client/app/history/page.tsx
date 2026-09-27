'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type SessionSummary = {
  session_id: string;
  started_at: string;
  ended_at: string | null;
  sample_count: string;
  avg_attention: string | null;
  avg_confusion: string | null;
};

type PlaybackPoint = {
  bucket: string;
  avg_attention: string | null;
  avg_confusion: string | null;
  sample_count: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function HistoryPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playback, setPlayback] = useState<PlaybackPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingPlayback, setLoadingPlayback] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/sessions`)
      .then((res) => res.json())
      .then((data) => {
        setSessions(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to fetch session history:', err);
        setLoading(false);
      });
  }, []);

  const selectSession = async (sessionId: string) => {
    setSelectedId(sessionId);
    setPlayback([]);
    setLoadingPlayback(true);
    try {
      const res = await fetch(`${API_URL}/api/sessions/${sessionId}/playback?bucketSeconds=5`);
      setPlayback(await res.json());
    } catch (err) {
      console.error('Failed to fetch playback:', err);
    } finally {
      setLoadingPlayback(false);
    }
  };

  return (
    <main className="page page--presenter">
      <div className="presenter">
        <div className="presenter__header">
          <div>
            <p className="page__eyebrow">Session History</p>
            <h1 className="page__title presenter__title">Past sessions</h1>
          </div>
          <Link href="/" className="page__link">
            ← Attendee view
          </Link>
        </div>

        {loading && <p className="page__hint">Loading…</p>}
        {!loading && sessions.length === 0 && <p className="page__hint">No sessions recorded yet.</p>}

        <div className="history-list">
          {sessions.map((s) => (
            <button
              key={s.session_id}
              onClick={() => selectSession(s.session_id)}
              className={`history-row ${selectedId === s.session_id ? 'is-selected' : ''}`}
            >
              <span className="history-row__id">{s.session_id}</span>
              <span className="history-row__meta">
                {new Date(s.started_at).toLocaleString()}
                {s.ended_at ? '' : ' · live'}
              </span>
              <span className="history-row__stats">
                <span>{s.sample_count} samples</span>
                <span>Attn {s.avg_attention ?? '—'} · Conf {s.avg_confusion ?? '—'}</span>
              </span>
            </button>
          ))}
        </div>

        {selectedId && (
          <div className="presenter__heatmap" style={{ marginTop: 32 }}>
            <h2 className="presenter__section-title">Playback — {selectedId} (5s buckets)</h2>
            {loadingPlayback ? (
              <p className="page__hint">Loading playback…</p>
              ) : playback.length === 0 ? (
              <p className="page__hint">No telemetry recorded for this session.</p>
            ) : (
              <div className="playback">
                {playback.map((p, i) => (
                  <div key={i} className="playback__bar-group">
                    <div
                      className="playback__bar playback__bar--confusion"
                      style={{ height: `${p.avg_confusion ?? 0}%` }}
                      title={`Confusion: ${p.avg_confusion ?? '—'}`}
                    />
                    <div
                      className="playback__bar playback__bar--attention"
                      style={{ height: `${p.avg_attention ?? 0}%` }}
                      title={`Attention: ${p.avg_attention ?? '—'}`}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="playback__legend">
              <span><i className="playback__swatch playback__swatch--attention" /> Attention</span>
              <span><i className="playback__swatch playback__swatch--confusion" /> Confusion</span>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}