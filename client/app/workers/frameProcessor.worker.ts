import {
  FilesetResolver,
  FaceLandmarker,
  type FaceLandmarkerResult,
} from '@mediapipe/tasks-vision';

type InboundMessage =
  | { type: 'frame'; bitmap: ImageBitmap; timestamp: number }
  | { type: 'stop' };

type OutboundMessage =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | {
      type: 'stats';
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

let faceLandmarker: FaceLandmarker | null = null;
let isReady = false;
let isInitializing = false;
let framesProcessed = 0;
let frameTimestamps: number[] = [];
let lastTimestamp = -1;

let lightingCanvas: OffscreenCanvas | null = null;
let lightingCtx: OffscreenCanvasRenderingContext2D | null = null;

const LIGHTING_DARK_THRESHOLD = 30;
const LIGHTING_BRIGHT_THRESHOLD = 225;
const OCCLUSION_STDDEV_THRESHOLD = 8;

async function initFaceLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );

  faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });

  isReady = true;
  isInitializing = false;
  (self as unknown as Worker).postMessage({ type: 'ready' } as OutboundMessage);
}

self.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;

  if (msg.type === 'stop') {
    framesProcessed = 0;
    frameTimestamps = [];
    lastTimestamp = -1;
    return;
  }

  if (msg.type === 'frame') {
    if (!isReady) {
      if (!isInitializing) {
        isInitializing = true;
        initFaceLandmarker().catch((err) => {
          isInitializing = false;
          (self as unknown as Worker).postMessage({
            type: 'error',
            message: err instanceof Error ? err.message : 'Model failed to load',
          } as OutboundMessage);
        });
      }
      msg.bitmap.close();
      // Same backpressure problem as a failed frame: if we don't ack this,
      // the main thread's workerBusyRef lock never releases, and it never
      // sends another frame again — even after the model finishes loading.
      (self as unknown as Worker).postMessage({ type: 'frameError' });
      return;
    }

    processFrame(msg.bitmap, msg.timestamp);
  }

};

function processFrame(bitmap: ImageBitmap, timestamp: number) {
  try {
    const { avgLuminance, luminanceStdDev } = computeLightingStats(bitmap);
    const lightingOk = avgLuminance >= LIGHTING_DARK_THRESHOLD && avgLuminance <= LIGHTING_BRIGHT_THRESHOLD;

    const safeTimestamp = timestamp > lastTimestamp ? timestamp : lastTimestamp + 1;
    lastTimestamp = safeTimestamp;

    const result: FaceLandmarkerResult = faceLandmarker!.detectForVideo(bitmap, safeTimestamp);

    framesProcessed += 1;
    const now = performance.now();
    frameTimestamps.push(now);
    frameTimestamps = frameTimestamps.filter((t) => now - t <= 1000);

    const faceDetected = result.faceLandmarks.length > 0;
    const possibleOcclusion = !faceDetected && luminanceStdDev < OCCLUSION_STDDEV_THRESHOLD;

    let attention = 0;
    let confusion = 0;
    let headYaw = 0;
    let headPitch = 0;

    if (faceDetected) {
      const pose = getHeadPose(result);
      headYaw = pose.yaw;
      headPitch = pose.pitch;

      const blendshapes = result.faceBlendshapes?.[0]?.categories ?? [];
      attention = computeAttentionScore(pose, blendshapes);
      confusion = computeConfusionScore(blendshapes);
    }

    (self as unknown as Worker).postMessage({
      type: 'stats',
      fps: frameTimestamps.length,
      framesProcessed,
      faceDetected,
      attention,
      confusion,
      headYaw,
      headPitch,
      avgLuminance,
      lightingOk,
      possibleOcclusion,
    } as OutboundMessage);
  }  catch (err) {
      console.error('detectForVideo failed:', err);
      // Must tell the main thread even on failure — otherwise its
      // backpressure logic waits forever for a response that never comes,
      // and the whole pipeline silently freezes after just one bad frame.
      (self as unknown as Worker).postMessage({ type: 'frameError' });
    } finally {
      bitmap.close();
    }
}

function computeLightingStats(bitmap: ImageBitmap): { avgLuminance: number; luminanceStdDev: number } {
  if (!lightingCanvas) {
    lightingCanvas = new OffscreenCanvas(64, 64);
    lightingCtx = lightingCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!lightingCtx) return { avgLuminance: 128, luminanceStdDev: 50 };

  const cropSize = 64;
  const sx = Math.max(0, Math.floor((bitmap.width - cropSize) / 2));
  const sy = Math.max(0, Math.floor((bitmap.height - cropSize) / 2));

  lightingCtx.drawImage(bitmap, sx, sy, cropSize, cropSize, 0, 0, cropSize, cropSize);
  const { data } = lightingCtx.getImageData(0, 0, cropSize, cropSize);

  let sum = 0;
  let sumSq = 0;
  const n = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += lum;
    sumSq += lum * lum;
  }

  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  const stddev = Math.sqrt(Math.max(0, variance));

  return { avgLuminance: Math.round(mean), luminanceStdDev: Math.round(stddev) };
}

function getHeadPose(result: FaceLandmarkerResult): { yaw: number; pitch: number; roll: number } {
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  if (!matrix) return { yaw: 0, pitch: 0, roll: 0 };

  const r00 = matrix[0], r10 = matrix[1], r20 = matrix[2];
  const r21 = matrix[6], r22 = matrix[10];

  const pitch = Math.asin(Math.max(-1, Math.min(1, -r20))) * (180 / Math.PI);
  const yaw = Math.atan2(r10, r00) * (180 / Math.PI);
  const roll = Math.atan2(r21, r22) * (180 / Math.PI);

  return { yaw, pitch, roll };
}

type Blendshape = { categoryName: string; score: number };

function getScore(categories: Blendshape[], name: string): number {
  return categories.find((c) => c.categoryName === name)?.score ?? 0;
}

function computeAttentionScore(
  pose: { yaw: number; pitch: number },
  blendshapes: Blendshape[]
): number {
  const YAW_TOLERANCE = 20;
  const PITCH_TOLERANCE = 15;

  const yawPenalty = Math.max(0, Math.abs(pose.yaw) - YAW_TOLERANCE) * 1.5;
  const pitchPenalty = Math.max(0, Math.abs(pose.pitch) - PITCH_TOLERANCE) * 1.5;

  const gazeAway =
    (getScore(blendshapes, 'eyeLookOutLeft') +
      getScore(blendshapes, 'eyeLookOutRight') +
      getScore(blendshapes, 'eyeLookDownLeft') +
      getScore(blendshapes, 'eyeLookDownRight')) /
    4;
  const gazePenalty = gazeAway * 40;

  const score = 100 - yawPenalty - pitchPenalty - gazePenalty;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function computeConfusionScore(blendshapes: Blendshape[]): number {
  const au4 = (getScore(blendshapes, 'browDownLeft') + getScore(blendshapes, 'browDownRight')) / 2;
  const au7 = (getScore(blendshapes, 'eyeSquintLeft') + getScore(blendshapes, 'eyeSquintRight')) / 2;
  const au24 = (getScore(blendshapes, 'mouthPressLeft') + getScore(blendshapes, 'mouthPressRight')) / 2;

  const weighted = au4 * 0.5 + au7 * 0.25 + au24 * 0.25;
  return Math.round(Math.max(0, Math.min(100, weighted * 100)));
}

export {};