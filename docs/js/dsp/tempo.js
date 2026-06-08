// Global tempo estimate via autocorrelation of the onset envelope, with a
// soft prior around a preferred BPM (resolves some octave ambiguity).
import { ENV_FPS } from "./constants.js";

export function estimateTempo(env, { minBpm = 60, maxBpm = 200, priorBpm = 120,
  fps = ENV_FPS } = {}) {
  // mean-remove
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length || 1;
  const x = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) x[i] = env[i] - mean;

  const minLag = Math.floor((60 / maxBpm) * fps);
  const maxLag = Math.ceil((60 / minBpm) * fps);
  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag && lag < x.length; lag++) {
    let ac = 0;
    for (let i = lag; i < x.length; i++) ac += x[i] * x[i - lag];
    const bpm = (60 * fps) / lag;
    // log-normal-ish prior weight around priorBpm (octave-tolerant, gentle)
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / priorBpm) / 0.9, 2));
    const score = ac * w;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  return (60 * fps) / bestLag;
}
