// jam-yourself web app: load/record takes -> analyse (count-in + beats) ->
// straighten onto a common tempo grid -> nudge -> mix. All in the browser.
//
// Embeddable: `mountApp(rootEl)` builds its own DOM inside rootEl (scoped under
// the `.jy` class), so it drops into any page (e.g. a QuantenBlog component
// mount point) without touching global styles. Returns a destroy() function.
import { SR } from "./dsp/constants.js";
import { analyzeTake, straightenCurve } from "./dsp/engine.js";
import { trimToDownbeat } from "./dsp/countin.js";
import { mixStems, nudge as nudgeShift } from "./dsp/mix.js";
import { warpStretch } from "./dsp/stretch.js";
import { decodeToMono, Transport, wavBlob } from "./audio.js";
import { makeTrackRow, refreshTrackRow, drawWaveform } from "./ui.js";
import { Recorder } from "./recorder.js";
import { renderTiledVideo } from "./videorender.js";

const COLORS = ["#22d3ee", "#fb7185", "#f59e0b", "#60a5fa", "#a78bfa", "#34d399"];

const TEMPLATE = `
  <header>
    <h1>jam<span>-</span>yourself</h1>
    <p class="tag">Be your own band. Count in <b>1-2-3-4</b>, play each part, and we
      lock them together — no metronome.</p>
  </header>
  <section class="bar">
    <label class="drop">
      <input type="file" class="file" accept="audio/*,video/*" multiple hidden />
      <span>＋ drop / choose takes</span>
    </label>
    <div class="recgrp">
      <button class="rec">● Record</button>
      <label class="chk"><input type="checkbox" class="rec-video" /> camera</label>
      <div class="meter"><div class="rec-meter"></div></div>
    </div>
    <div class="ctrl">
      <label>tempo
        <input type="number" class="bpm-input" placeholder="auto" min="40" max="220" />
        <span class="hint">auto: <b class="bpm-auto">–</b></span>
      </label>
      <label class="chk"><input type="checkbox" class="keep-countin" /> keep count-in</label>
      <label class="chk"><input type="checkbox" class="view-aligned" /> aligned view</label>
      <button class="play">▶ Play mix</button>
      <button class="download">⤓ WAV</button>
      <button class="render-vid" hidden>▶ Render video</button>
    </div>
    <div class="status"></div>
  </section>
  <video class="rec-preview" muted autoplay playsinline hidden></video>
  <section class="tracks"></section>
  <section class="video" hidden>
    <div class="master-head"><h2>video</h2><span class="vid-status"></span></div>
    <video class="vid-out" controls playsinline></video>
    <div class="vid-actions"><button class="vid-dl">⤓ video (mp4)</button></div>
  </section>
  <section class="master">
    <div class="master-head">
      <h2>mix</h2>
      <div class="legend">
        <span><i class="c-count"></i> count-in</span>
        <span><i class="c-down"></i> downbeat</span>
        <span><i class="c-beat"></i> beat grid</span>
        <span><i class="c-play"></i> playhead</span>
      </div>
    </div>
    <canvas class="master-wave"></canvas>
  </section>
  <footer>Runs entirely in your browser — your audio never leaves your machine.</footer>`;

function ensureCss(href) {
  if (![...document.querySelectorAll("link[rel=stylesheet]")].some((l) => l.href.includes(href)))
    { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.appendChild(l); }
}

export function mountApp(rootEl, opts = {}) {
  if (opts.cssHref) ensureCss(opts.cssHref);
  rootEl.classList.add("jy");
  rootEl.innerHTML = TEMPLATE;
  const $ = (s) => rootEl.querySelector(s);

  const tracksEl = $(".tracks");
  const statusEl = $(".status");
  const masterCanvas = $(".master-wave");
  const recBtn = $(".rec");
  const setStatus = (s) => { statusEl.textContent = s; };

  const state = { tracks: [], mix: null, transport: new Transport(),
                  keepCountin: false, targetBpm: null, recording: false };
  const recorder = new Recorder();
  let recCount = 0;

  const medianBpm = () => {
    const bpms = state.tracks.filter((t) => t.analysis && t.analysis.countin)
      .map((t) => t.analysis.countin.bpm).sort((a, b) => a - b);
    return bpms.length ? bpms[Math.floor(bpms.length / 2)] : null;
  };

  async function addTrack(name, blob, { videoBlob = null, videoExt = "webm",
                                        fromRec = false, recVideo = false } = {}) {
    setStatus(`decoding ${name} …`);
    let mono;
    try { mono = await decodeToMono(blob); }
    catch (e) { setStatus(`could not decode ${name}`); return; }
    setStatus(`analysing ${name} …`);
    const analysis = analyzeTake(mono);
    const track = { name, mono, analysis, nudge: 0, mute: false,
                    videoBlob, videoExt, hasVideo: !!videoBlob, fromRec, recVideo,
                    color: COLORS[state.tracks.length % COLORS.length] };
    state.tracks.push(track);
    const row = makeTrackRow(track, {
      onNudge: () => recompute(),
      onMute: () => recompute(),
      onRemove: () => { state.tracks = state.tracks.filter((t) => t !== track); row.remove(); recompute(); },
      onRetake: async () => {           // discard this take and record a fresh one
        state.tracks = state.tracks.filter((t) => t !== track); row.remove();
        await recompute();
        await startRec(track.recVideo);
      },
    });
    tracksEl.appendChild(row);
    refreshTrackRow(track, SR);
  }

  async function addFiles(files) {
    for (const file of files) {
      const isVideo = (file.type || "").startsWith("video/");
      const ext = (file.name.split(".").pop() || "").toLowerCase() || "mp4";
      await addTrack(file.name, file, isVideo ? { videoBlob: file, videoExt: ext } : {});
    }
    await recompute();
  }

  async function recompute() {
    $(".bpm-auto").textContent = medianBpm() ? `${medianBpm().toFixed(0)} bpm` : "–";
    const usable = state.tracks.filter((t) => t.analysis && t.analysis.countin && !t.mute);
    if (!usable.length) { state.mix = null; drawMaster(); setStatus("load or record takes with a count-in"); return; }
    const target = state.targetBpm || medianBpm();
    const period = 60 / target;
    state.period = period;
    setStatus("straightening & mixing …");
    await new Promise((r) => setTimeout(r, 10));
    const stems = [];
    for (const t of usable) {
      const a = t.analysis, ci = a.countin;
      // beat list (absolute) the warp grids onto. When keeping the count-in we
      // must include the FOUR count beats (they're not in a.beats, which starts
      // at the downbeat) — otherwise the count-in region gets mis-warped.
      const anchor = state.keepCountin ? ci.counts[0] : a.downbeat;
      const absBeats = state.keepCountin
        ? [...ci.counts, ci.downbeat, ...a.beats]
        : [a.downbeat, ...a.beats];
      const rel = absBeats.map((b) => b - anchor).filter((b) => b >= -1e-6).sort((x, y) => x - y);
      const beatsRel = [];
      for (const v of rel) if (!beatsRel.length || v > beatsRel[beatsRel.length - 1] + 0.05) beatsRel.push(Math.max(0, v));
      if (!beatsRel.length || beatsRel[0] > 1e-3) beatsRel.unshift(0);

      const warp = straightenCurve(beatsRel, period);
      t._warpFn = warp; t._anchor = anchor;     // reused by the video render
      const body = trimToDownbeat(t.mono, anchor);
      let warped = warpStretch(body, warp);
      if (t.nudge) warped = nudgeShift(warped, t.nudge, period, SR);
      t._aligned = warped;                      // shown in "aligned view"
      stems.push(warped);
    }
    state.mix = mixStems(stems);
    drawMaster();
    $(".render-vid").hidden = !usable.some((t) => t.hasVideo);
    refreshAll();
    setStatus(`mixed ${usable.length} take(s) @ ${target.toFixed(0)} bpm — ${(state.mix.length / SR).toFixed(1)}s`);
  }

  function refreshAll() {
    const view = $(".view-aligned").checked ? "aligned" : "raw";
    const durs = state.tracks.map((t) => (view === "aligned" && t._aligned ? t._aligned.length : t.mono.length) / SR);
    const span = durs.length ? Math.max(...durs) : 0;
    state.tracks.forEach((t) => refreshTrackRow(t, SR, {
      view, spanDur: span, period: state.period, keepCountin: state.keepCountin,
    }));
  }

  function drawMaster(playheadT = null) {
    if (!state.mix) { const c = masterCanvas.getContext("2d"); c.clearRect(0, 0, masterCanvas.width, masterCanvas.height); return; }
    drawWaveform(masterCanvas, state.mix, SR, { playheadT });
  }

  state.transport.onTime = (t) => drawMaster(t);
  state.transport.onEnd = () => { $(".play").textContent = "▶ Play mix"; };

  $(".play").onclick = () => {
    if (state.transport.playing) { state.transport.stop(); $(".play").textContent = "▶ Play mix"; return; }
    if (!state.mix) return;
    state.transport.play(state.mix, SR); $(".play").textContent = "■ Stop";
  };
  $(".download").onclick = () => {
    if (!state.mix) return;
    const url = URL.createObjectURL(wavBlob(state.mix, SR));
    const a = document.createElement("a"); a.href = url; a.download = "jam.wav"; a.click();
    URL.revokeObjectURL(url);
  };
  $(".keep-countin").onchange = (e) => { state.keepCountin = e.target.checked; recompute(); };
  $(".view-aligned").onchange = () => refreshAll();
  $(".bpm-input").onchange = (e) => { const v = parseFloat(e.target.value); state.targetBpm = v > 0 ? v : null; recompute(); };

  // render tiled video (ffmpeg.wasm) from the video takes + locked mix
  let lastVideoUrl = null;
  $(".render-vid").onclick = async () => {
    if (!state.mix) return;
    const vids = state.tracks.filter((t) => t.analysis && t.analysis.countin && !t.mute && t.hasVideo && t._warpFn);
    if (!vids.length) return;
    $(".video").hidden = false;
    const vstat = $(".vid-status");
    $(".render-vid").disabled = true;
    vstat.textContent = "loading video engine (first run downloads ffmpeg.wasm) …";
    try {
      const specs = vids.map((t) => ({ blob: t.videoBlob, ext: t.videoExt || "webm",
        downbeat: t._anchor, warpFn: t._warpFn, nudge: t.nudge }));
      const blob = await renderTiledVideo(specs, wavBlob(state.mix, SR), {
        period: state.period, durationSec: state.mix.length / SR,
        onProgress: (p) => { vstat.textContent = `rendering video … ${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; },
      });
      if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
      lastVideoUrl = URL.createObjectURL(blob);
      $(".vid-out").src = lastVideoUrl;
      state.videoBlob = blob;
      vstat.textContent = `done — ${vids.length} tile(s)`;
    } catch (e) {
      vstat.textContent = "video render failed: " + ((e && e.message) || e);
      console.error(e);
    } finally { $(".render-vid").disabled = false; }
  };
  $(".vid-dl").onclick = () => {
    if (!state.videoBlob) return;
    const u = URL.createObjectURL(state.videoBlob);
    const a = document.createElement("a"); a.href = u; a.download = "jam.mp4"; a.click(); URL.revokeObjectURL(u);
  };

  // record from mic / camera (with live camera preview + retake)
  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const preview = $(".rec-preview");

  async function startRec(video) {
    if (state.recording) return false;
    try {
      await recorder.start({ video, onLevel: (p, t) => {
        $(".rec-meter").style.width = `${Math.min(100, p * 140)}%`;
        recBtn.textContent = `■ Stop ${fmtT(t)}`;
      } });
    } catch (e) { setStatus("microphone/camera permission denied or unavailable"); return false; }
    state.recording = true; state.recVideo = video;
    recBtn.classList.add("on"); recBtn.textContent = "■ Stop 0:00";
    if (video && recorder.stream) {
      preview.srcObject = recorder.stream; preview.hidden = false;
      try { await preview.play(); } catch (e) {}
    }
    setStatus("recording — count in 1-2-3-4, then play");
    return true;
  }
  async function stopRec() {
    if (!state.recording) return;
    const { blob, hasVideo } = await recorder.stop();
    state.recording = false; recBtn.classList.remove("on"); recBtn.textContent = "● Record";
    $(".rec-meter").style.width = "0%";
    preview.srcObject = null; preview.hidden = true;
    await addTrack(`take ${++recCount} (${hasVideo ? "cam" : "mic"})`, blob,
      { videoBlob: hasVideo ? blob : null, fromRec: true, recVideo: hasVideo });
    await recompute();   // recorded takes must re-mix too (drag&drop already does)
  }
  recBtn.onclick = () => { if (state.recording) stopRec(); else startRec($(".rec-video").checked); };

  // drag & drop + file input
  const drop = $(".drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $(".file").addEventListener("change", (e) => { if (e.target.files.length) addFiles([...e.target.files]); });

  const onResize = () => { refreshAll(); drawMaster(); };
  window.addEventListener("resize", onResize);
  setStatus("drop or record your count-in takes to start");

  return function destroy() {
    try { state.transport.stop(); } catch (e) {}
    if (state.recording) recorder.stop().catch(() => {});
    window.removeEventListener("resize", onResize);
    rootEl.innerHTML = "";
  };
}
