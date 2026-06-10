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

// Warp curve f: take-time -> grid-time. Each beat is SNAPPED to its nearest grid
// slot k = round(beat / expectedPeriod) rather than numbered consecutively, so a
// spurious near-downbeat beat (or an octave/extra/missed beat) lands on the right
// slot instead of shoving everything one beat over (which inserts a phantom pause
// at the start). expectedPeriod is the take's own beat period (count-in tempo);
// targetPeriod is the common grid period. beats[] in seconds, relative to the
// downbeat (0).
export function warpCurveFromBeats(beats, targetPeriod, expectedPeriod = targetPeriod) {
  const byK = new Map();                          // grid slot -> take-times
  for (const t of beats) {
    if (t < -1e-6) continue;
    const k = Math.max(0, Math.round(t / expectedPeriod));
    (byK.get(k) || byK.set(k, []).get(k)).push(Math.max(0, t));
  }
  const xs = [], ys = [];
  for (const k of [...byK.keys()].sort((a, b) => a - b)) {
    const arr = byK.get(k).sort((a, b) => a - b);
    const med = arr[Math.floor(arr.length / 2)];  // robust take-time for this slot
    if (xs.length && med <= xs[xs.length - 1] + 1e-3) continue;
    xs.push(med); ys.push(k * targetPeriod);
  }
  if (!xs.length) { xs.push(0); ys.push(0); }
  if (ys[0] === 0) xs[0] = 0; else { xs.unshift(0); ys.unshift(0); }
  if (xs.length < 2) { xs.push(xs[0] + expectedPeriod); ys.push(ys[0] + targetPeriod); }
  return new Pchip(xs, ys);
}
