// RMS-match each stem to a common loudness, sum, peak-limit. (Matches the
// Python pipeline.mix_stems.)
export function rms(y) {
  let s = 0;
  for (let i = 0; i < y.length; i++) s += y[i] * y[i];
  return Math.sqrt(s / (y.length || 1));
}

export function mixStems(signals, targetRms = 0.12) {
  const leveled = signals.map((s) => {
    const g = targetRms / (rms(s) + 1e-9);
    const out = new Float32Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s[i] * g;
    return out;
  });
  const n = Math.min(...leveled.map((s) => s.length));
  const m = new Float32Array(n);
  for (const s of leveled) for (let i = 0; i < n; i++) m[i] += s[i];
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(m[i]));
  if (peak > 0.97) { const g = 0.97 / peak; for (let i = 0; i < n; i++) m[i] *= g; }
  return m;
}

// Shift a stem by a whole number of beats (+later pads front, -earlier trims).
export function nudge(y, beats, period, sr) {
  const n = Math.round(Math.abs(beats) * period * sr);
  if (beats > 0) { const out = new Float32Array(y.length + n); out.set(y, n); return out; }
  if (beats < 0) return y.subarray ? y.subarray(n) : y.slice(n);
  return y;
}
