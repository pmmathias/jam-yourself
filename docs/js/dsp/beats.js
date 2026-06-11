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

// Tempo coupling is LOCAL, not anchored to a single global tempo. The idea
// (from the player's reality): over a long take — minutes — the tempo can
// genuinely drift a lot, well past ±12%; only pros hold a click. But within a
// short horizon (~10s, a handful of beats) the tempo is steady, so a peak that
// sits far off the predicted beat is almost always an OFFBEAT (syncope / ghost
// hit), not a sudden tempo change. So:
//   * the per-hop search window and the smoothness penalty both reference the
//     LAST measured interval (running tempo), not the count-in period — this
//     lets the tempo drift freely over the whole take while staying tight
//     beat-to-beat (an offbeat would need a >windowFrac jump and is rejected);
//   * the only use of the count-in period is (a) to seed the very first hop and
//     (b) an ABSOLUTE clamp [period*0.6, period*1.6] on the running tempo, the
//     sole guard against the grid slowly creeping into a 0.5x/2x octave lock.
//     The clamp adds NO cost, so it never fights honest drift inside the band.
// Through a short pause the DP simply continues at the running tempo.
export function trackBeatsFromEnv(env, bpm, { fps = ENV_FPS, tightness = 100, windowFrac = 0.2 } = {}) {
  const n = env.length;
  if (n < 2) return [];
  const period = (60 / bpm) * fps; // frames per beat (count-in tempo)
  const lo = period * 0.6, hi = period * 1.6; // absolute octave guard
  const ls = localScore(env);

  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lastD = new Int32Array(n);       // interval (frames) that led INTO frame i
  for (let i = 0; i < n; i++) score[i] = ls[i]; // cost of starting a sequence here

  // forward relaxation: from each frame j, step to i = j + d for d within
  // ±windowFrac of j's running tempo (or the count-in period at a sequence start).
  for (let j = 0; j < n; j++) {
    const expected = lastD[j] > 0 ? Math.min(hi, Math.max(lo, lastD[j])) : period;
    const dMin = Math.max(1, Math.round(expected * (1 - windowFrac)));
    const dMax = Math.round(expected * (1 + windowFrac));
    for (let d = dMin; d <= dMax; d++) {
      const i = j + d;
      if (i >= n) break;
      // penalise tempo CHANGE (vs the previous interval), not deviation from a
      // fixed tempo; the first hop has no previous interval so it's seeded to
      // the count-in period instead.
      const ref = lastD[j] > 0 ? lastD[j] : period;
      const txcost = -tightness * Math.pow(Math.log(d / ref), 2);
      const full = score[j] + ls[i] + txcost;
      if (full > score[i]) { score[i] = full; back[i] = j; lastD[i] = d; }
    }
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
