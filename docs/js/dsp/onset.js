// Spectral-flux onset-strength envelope + onset peak picking.
// The browser-side equivalent of librosa.onset.onset_strength/onset_detect.
import { SR, HOP, N_FFT } from "./constants.js";
import { magnitudeSpectrum } from "./fft.js";

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

// Onset-strength envelope: half-wave-rectified spectral flux per hop.
export function onsetEnvelope(y, sr = SR, hop = HOP, nFFT = N_FFT) {
  const win = hann(nFFT);
  const nFrames = Math.max(0, 1 + Math.floor((y.length - nFFT) / hop));
  const env = new Float32Array(nFrames);
  let prev = null;
  const frame = new Float32Array(nFFT);
  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    for (let i = 0; i < nFFT; i++) frame[i] = y[start + i] * win[i];
    const mag = magnitudeSpectrum(frame);
    if (prev) {
      let flux = 0;
      for (let i = 0; i < mag.length; i++) {
        const d = mag[i] - prev[i];
        if (d > 0) flux += d;
      }
      env[f] = flux;
    }
    prev = mag;
  }
  // normalise to unit-ish scale (helps thresholds be sr/level independent)
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean = mean / (env.length || 1) + 1e-9;
  for (let i = 0; i < env.length; i++) env[i] /= mean;
  return env;
}

// Peak-pick onset frames from an envelope (adaptive local-mean threshold).
// Returns frame indices. Mirrors the spirit of librosa.onset.onset_detect.
export function pickOnsets(env, { preMax = 3, postMax = 3, preAvg = 10,
  postAvg = 10, delta = 0.1, wait = 3, floorMean = 1.0 } = {}) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean = mean / (n || 1) + 1e-9;
  const floor = floorMean * mean; // drop weak spurious onsets (breath/noise)
  // relative to AVERAGE flux (scale-invariant): count clicks and played notes
  // sit well above average, junk in the gaps does not. Mean-based, not max-based,
  // so a loud later section can't raise the bar and hide soft early counts.
  const onsets = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (env[i] < floor) continue;
    let isMax = true;
    for (let k = Math.max(0, i - preMax); k <= Math.min(n - 1, i + postMax); k++) {
      if (env[k] > env[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - preAvg); k <= Math.min(n - 1, i + postAvg); k++) {
      sum += env[k]; cnt++;
    }
    const thresh = sum / cnt + delta;
    if (env[i] >= thresh && i - last >= wait) {
      onsets.push(i);
      last = i;
    }
  }
  return onsets;
}

export function framesToTimes(frames, sr = SR, hop = HOP) {
  return frames.map((f) => (f * hop) / sr);
}
