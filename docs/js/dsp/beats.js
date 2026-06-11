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

// Tempo coupling is LOCAL but to a SMOOTHED running tempo, not to one global
// tempo. The idea, from the player's reality: over a long take — minutes — the
// tempo can genuinely drift a lot, well past ±12% (only pros hold a click). But
// within a short horizon (~10s, a handful of beats) the tempo is steady, so a
// peak that sits far off the expected beat is almost always an OFFBEAT (syncope
// / ghost hit) or a subdivision, NOT a sudden tempo change. So the reference
// tempo is an EMA over recent beats:
//   * per-hop search window = ±windowFrac of the SMOOTHED tempo. An offbeat or
//     subdivision needs a >windowFrac jump and is rejected. Because the window
//     follows a SMOOTHED tempo (not the last interval), a couple of stray fast
//     beats can't drag the window down — it takes sustained evidence to shift
//     the tempo, so the tracker can't "walk down" into a subdivision over a few
//     hops the way last-interval coupling let it.
//   * the FIRST hop searches a WIDE ±firstHopFrac around the count-in period,
//     so a take counted slow but played fast (or vice versa) still locks onto
//     the actual played tempo; that first interval then fully seeds the EMA.
//   * the penalty is on deviation from the smoothed tempo (prefer steadiness);
//     honest slow drift barely deviates and is nearly free.
//   * an absolute clamp [period*0.6, period*1.6] is a final octave backstop.
// Through a short pause the DP simply continues at the running tempo.
export function trackBeatsFromEnv(env, bpm, {
  fps = ENV_FPS, tightness = 100, windowFrac = 0.14, firstHopFrac = 0.3, ema = 0.18,
} = {}) {
  const n = env.length;
  if (n < 2) return [];
  const period = (60 / bpm) * fps; // frames per beat (count-in tempo)
  const lo = period * 0.6, hi = period * 1.6; // absolute octave guard
  const ls = localScore(env);

  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const tempoRef = new Float32Array(n); // SMOOTHED running period (frames) at i
  const seeded = new Uint8Array(n);     // has frame i a predecessor (real tempo)?
  for (let i = 0; i < n; i++) score[i] = ls[i]; // cost of starting a sequence here

  // forward relaxation: from each frame j step to i = j + d for d within the
  // window around j's smoothed tempo (or a wide band around the count-in period
  // at a sequence start, to find the actual played tempo).
  for (let j = 0; j < n; j++) {
    const ref = seeded[j] ? Math.min(hi, Math.max(lo, tempoRef[j])) : period;
    const frac = seeded[j] ? windowFrac : firstHopFrac;
    const dMin = Math.max(1, Math.round(ref * (1 - frac)));
    const dMax = Math.round(ref * (1 + frac));
    for (let d = dMin; d <= dMax; d++) {
      const i = j + d;
      if (i >= n) break;
      // prefer holding the established (smoothed) tempo; honest slow drift stays
      // close to ref and is nearly free, a lurch is expensive.
      const txcost = -tightness * Math.pow(Math.log(d / ref), 2);
      const full = score[j] + ls[i] + txcost;
      if (full > score[i]) {
        score[i] = full; back[i] = j;
        // first real interval fully seeds the tempo; later beats nudge the EMA.
        tempoRef[i] = seeded[j]
          ? Math.min(hi, Math.max(lo, ema * d + (1 - ema) * tempoRef[j]))
          : d;
        seeded[i] = 1;
      }
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
