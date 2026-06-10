// Percussive count-in detection -- faithful port of the validated Python logic.
// Finds the earliest run of 4 evenly spaced onsets at a sane counting tempo.
import { SR, HOP } from "./constants.js";
import { onsetEnvelope, pickOnsets } from "./onset.js";

const MIN_IOI = 0.34; // ~176 bpm
const MAX_IOI = 0.80; // ~75 bpm  (caps below ~1s so half-tempo can't win)

function linfit(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

export function detectCountin(y, {
  sr = SR, hop = HOP, searchS = 10.0, nCounts = 4, tol = 0.08, t0Window = null,
  fromTime = 0,
} = {}) {
  if (t0Window == null) t0Window = searchS;
  const head = y.subarray ? y.subarray(0, Math.floor(searchS * sr)) : y.slice(0, Math.floor(searchS * sr));
  const env = onsetEnvelope(head, sr, hop);
  let frames = pickOnsets(env);
  // fromTime lets the user point past leading noise/fumbling ("the count-in is
  // here") — onsets before it are ignored entirely.
  if (fromTime > 0) frames = frames.filter((f) => (f * hop) / sr >= fromTime - 1e-9);
  if (frames.length < nCounts) throw new Error(`only ${frames.length} onsets; need ${nCounts}`);
  const times = frames.map((f) => (f * hop) / sr);

  const coverage = (t0, b) => {
    let hit = 0;
    for (let g = t0; g < searchS; g += b) {
      let bd = Infinity;
      for (const t of times) bd = Math.min(bd, Math.abs(t - g));
      if (bd <= tol) hit++;
    }
    return hit;
  };

  // Earliest evenly-spaced 4-grid at a sane counting tempo wins (coverage then
  // tightness break ties). Leading noise is skipped by pointing `fromTime` past
  // it (manual override in the UI), since separating arbitrary noise from a real
  // count-in by onset statistics alone isn't reliable.
  let best = null;
  for (const t0 of times) {
    if (t0 > t0Window) break;
    let t0best = null;
    for (let b = MIN_IOI; b <= MAX_IOI + 1e-9; b += 0.003) {
      const grid = [];
      for (let k = 0; k < nCounts; k++) grid.push(t0 + b * k);
      if (grid[grid.length - 1] > searchS) break;
      const idx = [];
      let err = 0, ok = true;
      for (const g of grid) {
        let bj = -1, bd = Infinity;
        for (let j = 0; j < times.length; j++) {
          const d = Math.abs(times[j] - g);
          if (d < bd) { bd = d; bj = j; }
        }
        if (bd > tol) { ok = false; break; }
        idx.push(bj); err += bd;
      }
      if (!ok) continue;
      const cov = coverage(t0, b);
      if (!t0best || cov > t0best.cov || (cov === t0best.cov && err < t0best.err))
        t0best = { idx, b, err, cov };
    }
    if (t0best) { best = t0best; break; }   // earliest valid t0
  }
  if (!best) throw new Error("no evenly-spaced count-in found");

  const matched = best.idx.map((j) => times[j]);
  const ks = matched.map((_, k) => k);
  const { slope, intercept } = linfit(ks, matched);
  let resid = 0;
  for (let k = 0; k < nCounts; k++) resid += Math.pow(matched[k] - (intercept + slope * k), 2);
  resid = Math.sqrt(resid / nCounts);
  return {
    counts: matched,
    beatPeriod: slope,
    bpm: 60 / slope,
    downbeat: intercept + slope * nCounts, // "1" after "...4"
    confidence: Math.max(0, 1 - resid / (slope + 1e-9)),
  };
}

export function trimToDownbeat(y, downbeat, sr = SR) {
  const i = Math.max(0, Math.round(downbeat * sr));
  return y.subarray ? y.subarray(i) : y.slice(i);
}
