// Render a tiled video in the browser via ffmpeg.wasm: each take's video is
// trimmed to its downbeat, time-warped onto the common grid (same setpts
// polynomial as the Python video.py), nudged, scaled into a tile, then all
// tiles are overlaid on black with the engine's locked mix as the soundtrack.
import { getFFmpeg, fetchFile } from "./ffmpeg.js";

// ---- least-squares polynomial fit (normal equations + Gaussian elimination) -
function polyfit(xs, ys, deg) {
  const n = xs.length, m = deg + 1;
  const A = Array.from({ length: m }, () => new Float64Array(m));
  const b = new Float64Array(m);
  const pow = xs.map((x) => { const p = new Float64Array(2 * deg + 1); let v = 1; for (let k = 0; k <= 2 * deg; k++) { p[k] = v; v *= x; } return p; });
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < m; r++) {
      b[r] += pow[i][r] * ys[i];
      for (let c = 0; c < m; c++) A[r][c] += pow[i][r + c];
    }
  }
  // solve A x = b
  for (let col = 0; col < m; col++) {
    let piv = col; for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-12;
    for (let c = col; c < m; c++) A[col][c] /= d; b[col] /= d;
    for (let r = 0; r < m; r++) if (r !== col) { const f = A[r][col]; for (let c = col; c < m; c++) A[r][c] -= f * A[col][c]; b[r] -= f * b[col]; }
  }
  return Array.from(b); // coeffs low->high
}

// setpts expression "max(0,(T + poly(T) + offset))/TB" for warp curve fn.
function setptsExpr(warpFn, fitDur, offset, maxDeg = 5) {
  const N = 200;
  const ts = Array.from({ length: N }, (_, i) => (i / (N - 1)) * fitDur);
  const corr = ts.map((t) => warpFn.evalScalar(t) - t);
  for (let deg = Math.min(maxDeg, N - 1); deg >= 1; deg--) {
    const c = polyfit(ts, corr, deg);            // low->high
    const f = (t) => { let v = 0; for (let k = c.length - 1; k >= 0; k--) v = v * t + c[k]; return t + v; };
    let mono = true; for (let i = 1; i < N; i++) if (f(ts[i]) <= f(ts[i - 1])) { mono = false; break; }
    if (!mono) continue;
    const terms = ["T"];
    c.forEach((coef, k) => { if (k === 0) terms.push(`(${coef.toExponential(8)})`); else terms.push(`(${coef.toExponential(8)})*pow(T\\,${k})`); });
    return `max(0\\,(${terms.join("+")})+(${offset.toExponential(8)}))`;
  }
  return `max(0\\,T+(${offset.toExponential(8)}))`; // fallback: identity + offset
}

function grid(n) { const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n)); return { cols, rows: Math.ceil(n / cols) }; }

// specs: [{ blob, ext, downbeat, warpFn, nudge }]; mixWavBlob; durationSec.
export async function renderTiledVideo(specs, mixWavBlob, {
  period, fps = 30, cellW = 360, cellH = 360, durationSec,
  onProgress = null, onLog = null,
} = {}) {
  const n = specs.length;
  // One monotonic 0..1 across all passes (n tile pre-passes + 1 compose) instead
  // of each ffmpeg exec resetting 0->100%. Each exec's raw progress maps into its
  // own slice [stage/STAGES, (stage+1)/STAGES]; a label says what's happening so
  // the gaps (file writes, engine load) read as "preparing …", not "stuck".
  const STAGES = n + 1;
  let stage = 0, label = "preparing";
  const emit = (sub = 0) => onProgress &&
    onProgress(Math.max(0, Math.min(1, (stage + Math.max(0, Math.min(1, sub))) / STAGES)), label);

  label = "loading video engine";
  const ff = await getFFmpeg({ onProgress: (p) => emit(p), onLog });

  // stage 1 — warp+scale each take to a tile
  for (let i = 0; i < n; i++) {
    stage = i; label = `preparing tile ${i + 1}/${n}`; emit(0);
    const s = specs[i];
    await ff.writeFile(`in${i}.${s.ext}`, await fetchFile(s.blob));
    const fitDur = Math.max(2, s.warpFn.xs[s.warpFn.xs.length - 1]);
    const expr = setptsExpr(s.warpFn, fitDur, (s.nudge || 0) * period);
    const vf = `setpts=(${expr})/TB,fps=${fps},`
      + `scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,`
      + `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    await ff.exec(["-ss", s.downbeat.toFixed(4), "-i", `in${i}.${s.ext}`,
      "-vf", vf, "-an", "-c:v", "libx264", "-preset", "ultrafast",
      "-pix_fmt", "yuv420p", `w${i}.mp4`]);
    emit(1);
  }

  // stage 2 — overlay tiles on black + locked mix as audio
  stage = n; label = "composing video"; emit(0);
  await ff.writeFile("mix.wav", await fetchFile(mixWavBlob));
  const { cols, rows } = grid(n);
  const GW = cols * cellW, GH = rows * cellH;
  const dur = durationSec.toFixed(3);
  const parts = [`color=c=black:s=${GW}x${GH}:r=${fps}:d=${dur}[bg]`];
  for (let i = 0; i < n; i++) parts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`);
  let prev = "bg";
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const nxt = i === n - 1 ? "vout" : `t${i}`;
    parts.push(`[${prev}][v${i}]overlay=${c * cellW}:${r * cellH}:eof_action=pass[${nxt === "vout" ? "vpre" : nxt}]`);
    prev = nxt === "vout" ? "vpre" : nxt;
  }
  parts.push(`[vpre]format=yuv420p[vout]`);
  const args = [];
  for (let i = 0; i < n; i++) args.push("-i", `w${i}.mp4`);
  args.push("-i", "mix.wav",
    "-filter_complex", parts.join(";"),
    "-map", "[vout]", "-map", `${n}:a`,
    "-t", dur, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-r", String(fps), "-c:a", "aac", "-b:a", "192k", "-shortest",
    // faststart: move the moov atom to the front so the file plays/streams and
    // shares cleanly on mobile (Save to Photos / WhatsApp) instead of needing a
    // full download first.
    "-movflags", "+faststart", "out.mp4");
  await ff.exec(args);
  emit(1);

  const data = await ff.readFile("out.mp4");
  // cleanup FS
  for (let i = 0; i < n; i++) { try { await ff.deleteFile(`in${i}.${specs[i].ext}`); await ff.deleteFile(`w${i}.mp4`); } catch (e) {} }
  try { await ff.deleteFile("mix.wav"); await ff.deleteFile("out.mp4"); } catch (e) {}
  return new Blob([data.buffer], { type: "video/mp4" });
}
