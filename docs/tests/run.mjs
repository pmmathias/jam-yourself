// Node test runner for the pure-JS DSP core (no browser, no deps).
import { SR, HOP } from "../js/dsp/constants.js";
import { magnitudeSpectrum } from "../js/dsp/fft.js";
import { onsetEnvelope, pickOnsets, framesToTimes } from "../js/dsp/onset.js";
import { detectCountin, trimToDownbeat } from "../js/dsp/countin.js";
import { trackBeats } from "../js/dsp/beats.js";
import { Pchip, warpCurveFromBeats } from "../js/dsp/warp.js";
import { mixStems } from "../js/dsp/mix.js";

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } }
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg} (${a} vs ${b}, eps ${eps})`); }

// ---- synthesis helpers -----------------------------------------------------
function clickBurst(sr = SR, dur = 0.03) {
  const n = Math.floor(dur * sr);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++)
    y[i] = Math.exp(-18 * (i / n)) * Math.sin((2 * Math.PI * 1500 * i) / sr);
  return y;
}
function place(times, durTotal, sr = SR, amp = () => 1) {
  const y = new Float32Array(Math.ceil(durTotal * sr));
  const c = clickBurst(sr);
  times.forEach((t, k) => {
    const i = Math.floor(t * sr); const a = amp(k);
    for (let j = 0; j < c.length && i + j < y.length; j++) y[i + j] += a * c[j];
  });
  return y;
}

// ---- 1. FFT ----------------------------------------------------------------
{
  const n = 1024, freq = 64; // exactly bin 64 at this length
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = Math.sin((2 * Math.PI * freq * i) / n);
  const mag = magnitudeSpectrum(sig);
  let peak = 0, peakBin = -1;
  for (let i = 0; i < mag.length; i++) if (mag[i] > peak) { peak = mag[i]; peakBin = i; }
  ok(peakBin === freq, `FFT peak at bin ${freq} (got ${peakBin})`);
}

// ---- 2. onset envelope peaks at clicks -------------------------------------
{
  const times = [0.5, 1.0, 1.5, 2.0];
  const y = place(times, 2.5);
  const env = onsetEnvelope(y);
  const onsets = framesToTimes(pickOnsets(env));
  ok(onsets.length >= 4, `detected >=4 onsets (got ${onsets.length})`);
  // every click should have an onset within 40ms
  const allHit = times.every((t) => onsets.some((o) => Math.abs(o - t) < 0.04));
  ok(allHit, "onset near every click");
}

// ---- 3. count-in detection (with stray + extra onsets) ---------------------
// stray sits >MAX_IOI before count 1 so it can't masquerade as a count.
for (const bpm of [100, 120, 144]) {
  const beat = 60 / bpm, lead = 1.0;
  const counts = [0, 1, 2, 3].map((k) => lead + k * beat);
  const db = lead + 4 * beat;
  const music = [];
  for (let t = db; t < 8; t += beat * (Math.random() < 0.4 ? 0.5 : 1)) music.push(t);
  const y = place([0.1, ...counts, ...music], 9);
  const r = detectCountin(y);
  near(r.bpm, bpm, 6, `countin bpm @${bpm}`);
  near(r.downbeat, db, 0.06, `countin downbeat @${bpm}`);
}

// ---- 4. count-in not at file start (talking/tuning first) ------------------
{
  const bpm = 110, beat = 60 / bpm;
  const counts = [0, 1, 2, 3].map((k) => 5.0 + k * beat); // count-in starts at 5s
  const noise = [0.2, 1.4, 1.9, 3.1]; // pre-count junk
  const y = place([...noise, ...counts], 9);
  const r = detectCountin(y);
  near(r.downbeat, 5.0 + 4 * beat, 0.07, "countin found after pre-roll noise");
}

// ---- 5. beat tracking on a steady click train ------------------------------
{
  const bpm = 120, beat = 0.5;
  const times = [];
  for (let k = 0; k < 24; k++) times.push(k * beat);
  const y = place(times, 13);
  const beats = trackBeats(y, bpm);
  ok(beats.length >= 18, `tracked enough beats (got ${beats.length})`);
  const iv = beats.slice(1).map((b, i) => b - beats[i]);
  const med = iv.sort((a, b) => a - b)[Math.floor(iv.length / 2)];
  near(med, beat, 0.05, "tracked beat interval ~0.5s");
}

// ---- 6. PCHIP monotone + interpolating -------------------------------------
{
  const xs = [0, 1, 2, 3, 4], ys = [0, 0.5, 0.9, 2.5, 2.6];
  const p = new Pchip(xs, ys);
  xs.forEach((x, i) => near(p.evalScalar(x), ys[i], 1e-9, `pchip interpolates knot ${i}`));
  const g = []; for (let x = 0; x <= 4; x += 0.01) g.push(p.evalScalar(x));
  let mono = true; for (let i = 1; i < g.length; i++) if (g[i] < g[i - 1] - 1e-9) mono = false;
  ok(mono, "pchip monotone for monotone data");
}

// ---- 7. warp curve from beats lands beats on the grid ----------------------
{
  const target = 0.5;
  const beats = [0, 0.55, 1.06, 1.62, 2.10]; // wobbly
  const c = warpCurveFromBeats(beats, target);
  beats.forEach((b, k) => near(c.evalScalar(b), k * target, 1e-6, `beat ${k} -> grid`));
}

// ---- 8. mix peak-limited ----------------------------------------------------
{
  const a = new Float32Array(SR).map((_, i) => 0.05 * Math.sin((2 * Math.PI * 110 * i) / SR));
  const b = new Float32Array(SR).map((_, i) => 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR));
  const m = mixStems([a, b]);
  let peak = 0; for (const v of m) peak = Math.max(peak, Math.abs(v));
  ok(peak <= 0.98, `mix peak-limited (${peak.toFixed(3)})`);
}

// ---- 9. time-varying warp stretch (SoundTouch) -----------------------------
{
  const { warpStretch } = await import("../js/dsp/stretch.js");
  const { Pchip } = await import("../js/dsp/warp.js");
  const iv = []; for (let k = 0; k < 20; k++) iv.push(0.5 * (1 + 0.12 * Math.sin((2 * Math.PI * k) / 8)));
  let t = 0; const times = [t]; for (const x of iv) { t += x; times.push(t); }
  const y = place(times, t + 0.5);
  const warp = new Pchip(times, times.map((_, k) => k * 0.5)); // -> steady 0.5s
  const warped = warpStretch(y, warp);
  const expLen = Math.round(warp.evalScalar(y.length / SR) * SR);
  near(warped.length, expLen, SR * 0.1, "warp-stretch output length");
  const before = framesToTimes(pickOnsets(onsetEnvelope(y)));
  const after = framesToTimes(pickOnsets(onsetEnvelope(warped)));
  const sd = (o) => { const a = o.slice(1).map((x, i) => x - o[i]).filter((d) => d > 0.2 && d < 0.9); const m = a.reduce((p, q) => p + q, 0) / a.length; return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length); };
  ok(sd(after) < sd(before), `stretch reduces drift sd (${(sd(before) * 1000).toFixed(0)}->${(sd(after) * 1000).toFixed(0)}ms)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
