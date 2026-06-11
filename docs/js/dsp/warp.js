// Monotone cubic (PCHIP / Fritsch-Carlson) interpolation -- the shape-preserving
// warp curve. Monotone so warped time never runs backwards.

export class Pchip {
  constructor(xs, ys) {
    // assume xs strictly increasing
    const n = xs.length;
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    const h = new Float64Array(n - 1);
    const delta = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i];
      delta[i] = (ys[i + 1] - ys[i]) / h[i];
    }
    const m = new Float64Array(n);
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (delta[i - 1] * delta[i] <= 0) {
        m[i] = 0;
      } else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
      }
    }
    this.m = m;
  }

  evalScalar(x) {
    const { xs, ys, m } = this;
    const n = xs.length;
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]); // linear extrap
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const h = xs[lo + 1] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[lo] + h10 * h * m[lo] + h01 * ys[lo + 1] + h11 * h * m[lo + 1];
  }

  eval(xArr) {
    const out = new Float64Array(xArr.length);
    for (let i = 0; i < xArr.length; i++) out[i] = this.evalScalar(xArr[i]);
    return out;
  }
}

// Warp curve f: take-time -> grid-time. Each beat advances the grid slot by the
// INTERVAL TO THE PREVIOUS beat (round(gap/expectedPeriod), min 1; 0 = duplicate,
// skipped) — i.e. incrementally, not by absolute round(beat/period). Absolute
// snapping accumulates rounding drift when the played tempo differs a little from
// expectedPeriod and then spuriously skips a slot (one played beat stretched
// across two grid beats). Incremental advance keeps consecutive beats one slot
// apart and still spans genuine gaps (missed beats). expectedPeriod is the take's
// played period; targetPeriod the common grid. beats[] relative to the downbeat.
export function warpCurveFromBeats(beats, targetPeriod, expectedPeriod = targetPeriod) {
  const sorted = beats.filter((t) => t >= -1e-6).map((t) => Math.max(0, t)).sort((a, b) => a - b);
  const xs = [], ys = [];
  let slot = 0, prevT = null;
  for (const t of sorted) {
    if (prevT === null) {
      slot = Math.max(0, Math.round(t / expectedPeriod));   // first beat's slot
    } else {
      const adv = Math.round((t - prevT) / expectedPeriod);
      if (adv <= 0) continue;                                // duplicate / too close
      slot += adv;
    }
    prevT = t;
    if (xs.length && t <= xs[xs.length - 1] + 1e-3) continue;
    xs.push(t); ys.push(slot * targetPeriod);
  }
  if (!xs.length) { xs.push(0); ys.push(0); }
  if (ys[0] === 0) xs[0] = 0; else { xs.unshift(0); ys.unshift(0); }
  if (xs.length < 2) { xs.push(xs[0] + expectedPeriod); ys.push(ys[0] + targetPeriod); }
  return new Pchip(xs, ys);
}
