'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  generateTeamLeadKeyPair,
  exportPublicKeySpki,
  decryptReport,
  type DecryptedReport,
  type EncryptedReport,
} from '../lib/reportCrypto';

type Status = 'idle' | 'generating' | 'registered' | 'error';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function TeamLeadPage() {
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [reports, setReports] = useState<DecryptedReport[]>([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [hasLoadedReports, setHasLoadedReports] = useState(false);

  const registerAsTeamLead = async () => {
    if (!sessionId) return;
    setStatus('generating');
    setErrorMsg('');

    try {
      const keyPair = await generateTeamLeadKeyPair();
      const publicKeySpki = await exportPublicKeySpki(keyPair.publicKey);

      const res = await fetch(`${API_URL}/api/sessions/${sessionId}/team-lead-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKeySpki }),
      });

      if (!res.ok) throw new Error(`Server rejected key registration (${res.status})`);

      setPrivateKey(keyPair.privateKey);
      setStatus('registered');
    } catch (err) {
      console.error('Team Lead registration failed:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Registration failed');
      setStatus('error');
    }
  };

  const loadReports = async () => {
    if (!privateKey || !sessionId) return;
    setLoadingReports(true);
    setErrorMsg('');

    try {
      const res = await fetch(`${API_URL}/api/sessions/${sessionId}/reports`);
      if (res.status === 403) throw new Error('Not authorized — register your key first.');
      if (!res.ok) throw new Error(`Failed to fetch reports (${res.status})`);

      const encryptedReports: { attendeeId: string; encrypted: EncryptedReport }[] = await res.json();
      const decrypted = await Promise.all(encryptedReports.map((r) => decryptReport(privateKey, r.encrypted)));

      decrypted.sort((a, b) => (b.avgConfusion ?? 0) - (a.avgConfusion ?? 0));
      setReports(decrypted);
      setHasLoadedReports(true);
    } catch (err) {
      console.error('Failed to load/decrypt reports:', err);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoadingReports(false);
    }
  };

  return (
    <main className="page page--presenter">
      <div className="presenter">
        <div className="presenter__header">
          <div>
            <p className="page__eyebrow">Team Lead</p>
            <h1 className="page__title presenter__title">Individual engagement reports</h1>
          </div>
          <Link href="/presenter" className="page__link">
            ← Presenter view
          </Link>
        </div>

        {status !== 'registered' ? (
          <div className="presenter__connect">
            <p className="page__hint" style={{ marginBottom: 16, maxWidth: '48ch' }}>
              Individual attendee data is end-to-end encrypted. Your browser generates an
              RSA-4096 keypair here — the private key never leaves this tab, and the server
              only ever sees the public half.
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
            <button
              className="camera-panel__button"
              onClick={registerAsTeamLead}
              disabled={!sessionId || status === 'generating'}
            >
              {status === 'generating' ? 'Generating RSA-4096 keypair…' : 'Verify as Team Lead'}
            </button>
            {status === 'error' && (
              <p className="page__hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
                {errorMsg}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="presenter__slide-controls">
              <span className="page__hint" style={{ margin: 0 }}>
                Verified for session <strong style={{ color: 'var(--text)' }}>{sessionId}</strong>
              </span>
              <button className="camera-panel__button" onClick={loadReports} disabled={loadingReports}>
                {loadingReports ? 'Decrypting…' : 'Load reports'}
              </button>
            </div>

            {errorMsg && (
              <p className="page__hint" style={{ color: 'var(--danger)', marginBottom: 16 }}>
                {errorMsg}
              </p>
            )}

            {reports.length > 0 && (
              <div className="report-list">
                {reports.map((r) => (
                  <div key={r.attendeeId} className="report-row">
                    <span className="report-row__id">{r.attendeeId.slice(0, 8)}</span>
                    <ScoreBar label="Attention" value={r.avgAttention ?? 0} color="var(--signal)" />
                    <ScoreBar label="Confusion" value={r.avgConfusion ?? 0} color="var(--danger)" />
                    <span className="report-row__samples">{r.sampleCount} samples</span>
                  </div>
                ))}
              </div>
            )}
            {hasLoadedReports && reports.length === 0 && !loadingReports && (
              <p className="page__hint">No attendees have joined this session yet.</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="report-row__bar">
      <div className="camera-panel__score-header">
        <span>{label}</span>
        <span className="camera-panel__score-value">{value}</span>
      </div>
      <div className="camera-panel__score-track">
        <div className="camera-panel__score-fill" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}