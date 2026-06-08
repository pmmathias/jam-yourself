// Dynamic-programming beat tracker (after Ellis 2007) on an onset envelope.
// Returns beat times in seconds for a take that starts on its downbeat.
import { ENV_FPS } from "./constants.js";
import { onsetEnvelope } from "./onset.js";

function localScore(env) {
  // light smoothing of the onset envelope
  const n = env.length;
  const out = new Float32Array(n);
  const r = 2;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j >= 0 && j < n) { s += env[j]; c++; }
    }
    out[i] = s / c;
  }
  return out;
}

export function trackBeatsFromEnv(env, bpm, { fps = ENV_FPS, tightness = 100 } = {}) {
  const n = env.length;
  if (n < 2) return [];
  const period = (60 / bpm) * fps; // frames per beat
  const ls = localScore(env);

  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  // search window around one period before each frame
  const wMin = Math.round(period * 0.5);
  const wMax = Math.round(period * 2.0);
  for (let i = 0; i < n; i++) {
    let best = ls[i];      // cost of starting a beat sequence here
    let bestJ = -1;
    for (let d = wMin; d <= wMax; d++) {
      const j = i - d;
      if (j < 0) break;
      const txcost = -tightness * Math.pow(Math.log(d / period), 2);
      const full = ls[i] + score[j] + txcost;
      if (full > best) { best = full; bestJ = j; }
    }
    score[i] = best;
    back[i] = bestJ;
  }

  // start backtrace from the best-scoring frame in the last period
  let endI = n - 1;
  let endBest = -Infinity;
  for (let i = Math.max(0, n - Math.round(period)); i < n; i++) {
    if (score[i] > endBest) { endBest = score[i]; endI = i; }
  }
  const beatsFrames = [];
  for (let i = endI; i >= 0; i = back[i]) {
    beatsFrames.push(i);
    if (back[i] === -1) break;
  }
  beatsFrames.reverse();
  return beatsFrames.map((f) => f / fps);
}

export function trackBeats(y, bpm, opts = {}) {
  return trackBeatsFromEnv(onsetEnvelope(y), bpm, opts);
}
