'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import CameraCapture from './components/CameraCapture';

function randomSessionId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function Home() {
  const [sessionId, setSessionId] = useState('');
  useEffect(() => {
    setSessionId(randomSessionId());
  }, []);

  return (
    <main className="page">
      <div className="page__inner">
        <section className="page__intro">
          <p className="page__eyebrow">Attendee</p>
          <h1 className="page__title">
            Read the room, without recording it.
          </h1>
          <p className="page__body">
            This tab runs alongside your meeting — Zoom, Meet, Teams, or a
            lecture hall camera. It never touches the call itself. Every frame
            is processed on your device; nothing is uploaded, stored, or seen
            by anyone else.
          </p>

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
          <p className="page__hint">
            Get this from your presenter, or share yours with them.{' '}
            <Link href={`/presenter?sessionId=${sessionId}`} className="page__link">
              Open presenter dashboard →
            </Link>
          </p>
        </section>

        <section className="page__stage">
          <CameraCapture sessionId={sessionId} />
        </section>
      </div>
    </main>
  );
}