// Pitch-preserving, time-VARYING time-stretch driven by a warp curve, via the
// vendored SoundTouch (WSOLA). The browser equivalent of warp_audio/rubberband.
import { SoundTouch, SimpleFilter } from "../../vendor/soundtouch.js";
import { SR } from "./constants.js";
import { Pchip } from "./warp.js";

// warp: Pchip mapping take-time -> grid-time (monotone). Returns mono Float32.
export function warpStretch(mono, warp, sr = SR, { block = 2048, dt = 0.03, pitchOctaves = 0 } = {}) {
  const n = mono.length;
  const takeDur = n / sr;
  const outLen = Math.max(1, Math.round(warp.evalScalar(takeDur) * sr));

  // inverse curve grid-time -> take-time, so we can set the local stretch based
  // on the OUTPUT position (decoupled from SoundTouch's internal read-ahead).
  const inv = new Pchip(Array.from(warp.ys), Array.from(warp.xs));

  const st = new SoundTouch();
  // Tighter-than-default WSOLA windows keep transients (drum/stick hits) from
  // wandering too far; rubberband (the Python reference) is sharper still, this
  // is the browser trade-off. seq/seek/overlap ms.
  st.stretch.setParameters(sr, 40, 15, 8);
  if (pitchOctaves) st.pitchOctaves = pitchOctaves;   // e.g. -1 = down one octave (bassify)
  const source = {
    extract(t, num, pos) {
      for (let i = 0; i < num; i++) {
        const si = pos + i;
        const v = si >= 0 && si < n ? mono[si] : 0; // zeros past end => flush tail
        t[i * 2] = v; t[i * 2 + 1] = v;
      }
      return num;
    },
  };
  const filter = new SimpleFilter(source, st);

  const out = new Float32Array(outLen);
  const blk = new Float32Array(block * 2);
  let filled = 0, iter = 0;
  const maxIter = Math.ceil(outLen / 1) + 100000;
  while (filled < outLen && ++iter < maxIter) {
    const gridT = filled / sr;
    const takeT = inv.evalScalar(gridT);
    const a = Math.max(0, takeT - dt);
    const b = takeT + dt;
    const slope = (warp.evalScalar(b) - warp.evalScalar(a)) / (b - a); // d grid/d take
    st.tempo = 1 / Math.max(0.25, Math.min(4, slope));
    const got = filter.extract(blk, block);
    if (got <= 0) break;
    for (let i = 0; i < got && filled < outLen; i++) out[filled++] = blk[i * 2];
  }
  return out;
}
