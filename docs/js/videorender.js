// Render a tiled video in the browser via ffmpeg.wasm: each take's video is
// trimmed to its downbeat, time-warped onto the common grid (same setpts
// polynomial as the Python video.py), nudged, scaled into a tile, then all
// tiles are overlaid on black with the engine's locked mix as the soundtrack.
import { getFFmpeg, fetchFile } from "./ffmpeg.js";

// setpts expression for the warp curve, built PIECEWISE-LINEAR straight from the
// warp knots (take-time xs -> grid-time ys, one knot per beat) — the same knots
// the audio is stretched through. A previous version fitted a single degree-<=5
// polynomial to the whole curve, which can't follow ~35 per-beat wiggles (or the
// slope kink between count-in and played tempo), so the picture drifted from its
// own sound by tens of ms in places on takes that weren't dead steady. Linear
// interpolation is exact at every beat and within a few ms between beats (where
// the audio's PCHIP is near-linear anyway), keeping video locked to the mix.
function setptsExpr(warpFn, offset) {
  let X = Array.from(warpFn.xs), Y = Array.from(warpFn.ys);
  // cap knots so the ffmpeg expression stays parseable on very long takes;
  // decimate uniformly but always keep the last knot.
  const MAXK = 120;
  if (X.length > MAXK) {
    const step = X.length / MAXK, nx = [], ny = [];
    for (let i = 0; i < MAXK; i++) { const j = Math.min(X.length - 1, Math.round(i * step)); nx.push(X[j]); ny.push(Y[j]); }
    if (nx[nx.length - 1] !== X[X.length - 1]) { nx.push(X[X.length - 1]); ny.push(Y[Y.length - 1]); }
    X = nx; Y = ny;
  }
  const n = X.length;
  const e = (v) => v.toExponential(8);
  if (n < 2) return `max(0\\,T+(${e(offset)}))`;            // degenerate: identity + offset
  const slope = (i) => (Y[i + 1] - Y[i]) / Math.max(1e-9, X[i + 1] - X[i]);
  const seg = (i) => `(${e(Y[i])}+(T-(${e(X[i])}))*(${e(slope(i))}))`;
  // beyond the last knot, extrapolate with the final segment's slope
  let expr = `(${e(Y[n - 1])}+(T-(${e(X[n - 1])}))*(${e(slope(n - 2))}))`;
  for (let i = n - 2; i >= 0; i--) expr = `if(lt(T\\,${e(X[i + 1])})\\,${seg(i)}\\,${expr})`;
  return `max(0\\,(${expr})+(${e(offset)}))`;
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
    // offset = whole-beat nudge + the sub-beat 'tighten' shift applied to this
    // take's audio in the mix, so the picture stays locked to the heard sound.
    const expr = setptsExpr(s.warpFn, (s.nudge || 0) * period + (s.tightenSec || 0));
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
