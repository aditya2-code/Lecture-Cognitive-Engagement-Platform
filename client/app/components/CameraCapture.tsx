'use client';

import { useEffect, useRef, useState } from 'react';
import { encodeTelemetry } from '../lib/telemetryCodec';

type CameraStatus = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable' | 'revoked';
type ModelStatus = 'loading' | 'ready' | 'error';
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

type WorkerStats = {
  fps: number;
  framesProcessed: number;
  faceDetected: boolean;
  attention: number;
  confusion: number;
  headYaw: number;
  headPitch: number;
  avgLuminance: number;
  lightingOk: boolean;
  possibleOcclusion: boolean;
};

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000/ws';
const MIN_CAPTURE_INTERVAL_MS = 200;
const MAX_CAPTURE_INTERVAL_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 15000;

export default function CameraCapture({ sessionId }: { sessionId: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const captureLoopRef = useRef<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const slideIndexRef = useRef<number>(0);
  const attendeeIdRef = useRef<string>('');

  const captureIntervalRef = useRef<number>(MIN_CAPTURE_INTERVAL_MS);
  const workerBusyRef = useRef(false);
  const lastFrameSentAtRef = useRef(0);
  const isSessionActiveRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const [status, setStatus] = useState<CameraStatus>('idle');
  const [modelStatus, setModelStatus] = useState<ModelStatus>('loading');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [packetsSent, setPacketsSent] = useState(0);
  const [slideIndex, setSlideIndex] = useState(0);
  const [targetFps, setTargetFps] = useState(5);

  const stopStream = (finalStatus: CameraStatus = 'idle') => {
    isSessionActiveRef.current = false;

    if (captureLoopRef.current !== null) {
      cancelAnimationFrame(captureLoopRef.current);
      captureLoopRef.current = null;
    }
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    workerRef.current?.postMessage({ type: 'stop' });
    workerRef.current?.terminate();
    workerRef.current = null;

    socketRef.current?.close();
    socketRef.current = null;

    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;

    captureIntervalRef.current = MIN_CAPTURE_INTERVAL_MS;
    reconnectAttemptsRef.current = 0;

    setStatus(finalStatus);
    setModelStatus('loading');
    setConnectionStatus('disconnected');
    setStats(null);
    setPacketsSent(0);
    setTargetFps(5);
  };

  const startSession = async () => {
    if (!sessionId) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unavailable');
      return;
    }

    setStatus('requesting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        audio: false,
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      const [track] = stream.getVideoTracks();
      track.onended = () => {
        console.warn('Camera track ended unexpectedly — permission revoked or device disconnected.');
        stopStream('revoked');
      };

      attendeeIdRef.current = crypto.randomUUID();
      isSessionActiveRef.current = true;
      setStatus('active');
      connectSocket();
      startWorker();
      startCaptureLoop();
    } catch (err) {
      console.error('Camera access failed:', err);
      setStatus('denied');
    }
  };

  const connectSocket = () => {
    setConnectionStatus((prev) => (prev === 'disconnected' ? 'connecting' : 'reconnecting'));

    const socket = new WebSocket(
      `${WS_URL}?sessionId=${sessionId}&role=attendee&attendeeId=${attendeeIdRef.current}`
    );

    socket.onopen = () => {
      setConnectionStatus('connected');
      reconnectAttemptsRef.current = 0;
    };

    socket.onclose = () => {
      socketRef.current = null;
      if (!isSessionActiveRef.current) {
        setConnectionStatus('disconnected');
        return;
      }
      setConnectionStatus('reconnecting');
      scheduleReconnect();
    };

    socket.onerror = (err) => console.error('WebSocket error:', err);

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'slideChange') {
          slideIndexRef.current = msg.slideIndex;
          setSlideIndex(msg.slideIndex);
        }
      } catch {
        // ignore non-JSON messages
      }
    };

    socketRef.current = socket;
  };

  const scheduleReconnect = () => {
    const attempt = reconnectAttemptsRef.current;
    const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
    reconnectAttemptsRef.current += 1;

    reconnectTimeoutRef.current = window.setTimeout(() => {
      if (isSessionActiveRef.current) connectSocket();
    }, delay);
  };

  const startWorker = () => {
    const worker = new Worker(
      new URL('../workers/frameProcessor.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;

      if (data.type === 'frameError') {
        // A single bad frame — release the backpressure lock so the next
        // frame can still be sent, don't treat this as a fatal error.
        workerBusyRef.current = false;
        return;
      }
      
      if (data.type === 'ready') {
        setModelStatus('ready');
      } else if (data.type === 'error') {
        console.error('Worker error:', data.message);
        workerBusyRef.current = false;
        setModelStatus('error');
      } else if (data.type === 'stats') {
        workerBusyRef.current = false;
        const processingTime = performance.now() - lastFrameSentAtRef.current;
        captureIntervalRef.current = adaptCaptureInterval(captureIntervalRef.current, processingTime);
        setTargetFps(Math.round((1000 / captureIntervalRef.current) * 10) / 10);

        setStats(data);
        sendTelemetry(data);
      }
    };

    workerRef.current = worker;
  };

  const sendTelemetry = (data: WorkerStats) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!data.lightingOk && !data.faceDetected) return;

    const packet = encodeTelemetry({
      timestamp: Date.now(),
      faceDetected: data.faceDetected,
      attention: data.attention,
      confusion: data.confusion,
      headYaw: data.headYaw,
      headPitch: data.headPitch,
      slideIndex: slideIndexRef.current,
    });

    socket.send(packet);
    setPacketsSent((n) => n + 1);
  };

  const startCaptureLoop = () => {
    const tick = async () => {
      const video = videoRef.current;
      const worker = workerRef.current;
      const now = performance.now();

      const readyToCapture =
        video &&
        worker &&
        video.readyState >= 2 &&
        !workerBusyRef.current &&
        now - lastFrameSentAtRef.current >= captureIntervalRef.current;

      if (readyToCapture) {
        try {
          const bitmap = await createImageBitmap(video!);
          workerBusyRef.current = true;
          lastFrameSentAtRef.current = now;
          worker!.postMessage({ type: 'frame', bitmap, timestamp: now }, [bitmap]);
        } catch {
          // transient failure on early frames — safe to skip
        }
      }

      captureLoopRef.current = requestAnimationFrame(tick);
    };

    captureLoopRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    return () => stopStream();
  }, []);

  return (
    <div className="camera-panel">
      <div className="camera-panel__frame">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`camera-panel__video ${status === 'active' ? 'is-live' : ''}`}
        />

        {status !== 'active' && (
          <div className="camera-panel__overlay">
            <StatusMessage status={status} />
          </div>
        )}

        {status === 'active' && (
          <div className="camera-panel__badge">
            <span
              className={`camera-panel__dot ${connectionStatus !== 'connected' ? 'is-warning' : ''}`}
            />
            {modelStatus === 'loading' && 'Loading model…'}
            {modelStatus === 'error' && 'Model failed to load'}
            {modelStatus === 'ready' &&
              connectionStatus === 'connected' &&
              `LIVE${stats ? ` · ~${targetFps}fps` : ''}`}
            {modelStatus === 'ready' && connectionStatus === 'reconnecting' && 'Reconnecting…'}
            {modelStatus === 'ready' && connectionStatus === 'connecting' && 'Connecting…'}
          </div>
        )}

        {status === 'active' && modelStatus === 'ready' && (
          <div className="camera-panel__slide-badge">Slide {slideIndex + 1}</div>
        )}

        {status === 'active' && stats && !stats.lightingOk && (
          <div className="camera-panel__warning-badge">
            {stats.avgLuminance < 30 ? 'Too dark' : 'Too bright'} for reliable detection
          </div>
        )}

        {status === 'active' && stats?.possibleOcclusion && (
          <div className="camera-panel__warning-badge">Camera may be obstructed</div>
        )}
      </div>

      {status === 'active' && modelStatus === 'ready' && stats && (
        <>
          <div className="camera-panel__scores">
            <ScoreBar
              label="Attention"
              value={stats.faceDetected ? stats.attention : 0}
              color="var(--signal)"
            />
            <ScoreBar
              label="Confusion"
              value={stats.faceDetected ? stats.confusion : 0}
              color="var(--danger)"
            />
          </div>

          <div className="camera-panel__stats">
            <StatItem label="Face" value={stats.faceDetected ? 1 : 0} />
            <StatItem label="Yaw°" value={Math.round(stats.headYaw)} />
            <StatItem label="Lum" value={stats.avgLuminance} />
            <StatItem label="Sent" value={packetsSent} />
          </div>
        </>
      )}

      <div className="camera-panel__controls">
        {status !== 'active' ? (
          <button
            onClick={startSession}
            disabled={status === 'requesting' || !sessionId}
            className="camera-panel__button"
          >
            {status === 'requesting' ? 'Requesting access…' : 'Start session'}
          </button>
        ) : (
          <button
            onClick={() => stopStream('idle')}
            className="camera-panel__button camera-panel__button--stop"
          >
            End session
          </button>
        )}
      </div>
    </div>
  );
}

function adaptCaptureInterval(currentIntervalMs: number, processingTimeMs: number): number {
  const HEADROOM = 1.3;
  const SMOOTHING = 0.5;

  const desired = Math.min(
    MAX_CAPTURE_INTERVAL_MS,
    Math.max(MIN_CAPTURE_INTERVAL_MS, processingTimeMs * HEADROOM)
  );
  const next = currentIntervalMs + (desired - currentIntervalMs) * SMOOTHING;

  return Math.round(Math.min(MAX_CAPTURE_INTERVAL_MS, Math.max(MIN_CAPTURE_INTERVAL_MS, next)));
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="camera-panel__score">
      <div className="camera-panel__score-header">
        <span>{label}</span>
        <span className="camera-panel__score-value">{value}</span>
      </div>
      <div className="camera-panel__score-track">
        <div
          className="camera-panel__score-fill"
          style={{ width: `${value}%`, background: color }}
        />
      </div>
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: number }) {
  return (
    <div className="camera-panel__stat">
      <span className="camera-panel__stat-value">{value}</span>
      <span className="camera-panel__stat-label">{label}</span>
    </div>
  );
}

function StatusMessage({ status }: { status: CameraStatus }) {
  switch (status) {
    case 'denied':
      return (
        <>
          <p className="camera-panel__overlay-title">Camera access denied</p>
          <p className="camera-panel__overlay-body">
            Allow camera access in your browser's site settings, then try again.
          </p>
        </>
      );
    case 'revoked':
      return (
        <>
          <p className="camera-panel__overlay-title">Camera access was interrupted</p>
          <p className="camera-panel__overlay-body">
            Permission was revoked or the device disconnected mid-session. Start again when ready.
          </p>
        </>
      );
    case 'unavailable':
      return (
        <>
          <p className="camera-panel__overlay-title">No camera found</p>
          <p className="camera-panel__overlay-body">
            This browser doesn't support camera capture, or no device was detected.
          </p>
        </>
      );
    case 'requesting':
      return <p className="camera-panel__overlay-title">Waiting for permission…</p>;
    default:
      return (
        <>
          <p className="camera-panel__overlay-title">No active feed</p>
          <p className="camera-panel__overlay-body">
            Open this alongside your meeting, then start a session.
          </p>
        </>
      );
  }
}