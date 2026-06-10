// High-level analysis used by the UI: detect the count-in and the beat grid of
// a take, and build its straightening warp curve. The actual audio time-stretch
// lives in stretch.js (browser, SoundTouch); here we produce the curve + markers.
import { SR } from "./constants.js";
import { onsetEnvelope, pickOnsets, framesToTimes } from "./onset.js";
import { detectCountin, trimToDownbeat } from "./countin.js";
import { trackBeats } from "./beats.js";
import { warpCurveFromBeats } from "./warp.js";

export { SR } from "./constants.js";
export { detectCountin, trimToDownbeat } from "./countin.js";
export { warpCurveFromBeats, Pchip } from "./warp.js";
export { mixStems, nudge } from "./mix.js";
export { trackBeats } from "./beats.js";

// Analyse a full take for display + processing. `fromTime` ignores onsets before
// it when detecting the count-in (manual override past leading noise).
export function analyzeTake(y, sr = SR, { fromTime = 0 } = {}) {
  const env = onsetEnvelope(y, sr);
  const onsetTimes = framesToTimes(pickOnsets(env), sr);
  let countin = null;
  try { countin = detectCountin(y, { sr, fromTime }); } catch (e) { countin = null; }

  let beats = [], bpm = null, downbeat = null;
  if (countin) {
    downbeat = countin.downbeat;
    bpm = countin.bpm;
    const body = trimToDownbeat(y, downbeat, sr);
    // beat times relative to the downbeat, shifted back to absolute take-time
    beats = trackBeats(body, bpm).map((t) => t + downbeat);
  }
  return { env, onsetTimes, countin, beats, bpm, downbeat,
           durationS: y.length / sr };
}

// Warp curve for one take: maps take-time (from downbeat) -> steady grid-time.
export function straightenCurve(beatsFromDownbeat, targetPeriod) {
  return warpCurveFromBeats(beatsFromDownbeat, targetPeriod);
}
