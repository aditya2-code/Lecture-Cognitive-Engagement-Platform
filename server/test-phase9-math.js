function computeLightingStats(rgbaData) {
  let sum = 0;
  let sumSq = 0;
  const n = rgbaData.length / 4;

  for (let i = 0; i < rgbaData.length; i += 4) {
    const lum = 0.299 * rgbaData[i] + 0.587 * rgbaData[i + 1] + 0.114 * rgbaData[i + 2];
    sum += lum;
    sumSq += lum * lum;
  }

  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  const stddev = Math.sqrt(Math.max(0, variance));

  return { avgLuminance: Math.round(mean), luminanceStdDev: Math.round(stddev) };
}

function adaptCaptureInterval(currentIntervalMs, processingTimeMs) {
  const MIN_INTERVAL = 200;
  const MAX_INTERVAL = 1000;
  const HEADROOM = 1.3;
  const SMOOTHING = 0.5;

  const desired = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, processingTimeMs * HEADROOM));
  const next = currentIntervalMs + (desired - currentIntervalMs) * SMOOTHING;

  return Math.round(Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, next)));
}

module.exports = { computeLightingStats, adaptCaptureInterval };