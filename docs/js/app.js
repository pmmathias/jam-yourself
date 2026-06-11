// jam-yourself web app: load/record takes -> analyse (count-in + beats) ->
// straighten onto a common tempo grid -> nudge -> mix. All in the browser.
//
// Embeddable: `mountApp(rootEl)` builds its own DOM inside rootEl (scoped under
// the `.jy` class), so it drops into any page (e.g. a QuantenBlog component
// mount point) without touching global styles. Returns a destroy() function.
import { SR } from "./dsp/constants.js";
import { analyzeTake, straightenCurve, trackBeats } from "./dsp/engine.js";
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
    <label class="drop lock">
      <input type="file" class="file" accept="audio/*,video/*" multiple hidden />
      <span>＋ drop / choose takes</span>
    </label>
    <div class="recgrp lock">
      <button class="rec">● Record</button>
      <label class="chk"><input type="checkbox" class="rec-video" /> camera</label>
      <div class="meter"><div class="rec-meter"></div></div>
    </div>
    <div class="ctrl">
      <label class="lock">tempo
        <input type="number" class="bpm-input" placeholder="auto" min="40" max="220" />
        <span class="hint">auto: <b class="bpm-auto">–</b></span>
      </label>
      <label class="chk lock"><input type="checkbox" class="keep-countin" /> keep count-in</label>
      <label class="chk"><input type="checkbox" class="view-aligned" /> aligned view</label>
      <button class="play">▶ Play mix</button>
      <label class="chk"><input type="checkbox" class="metro" /> 🔊 click</label>
      <button class="download">⤓ WAV</button>
      <button class="render-vid lock" hidden>▶ Render video</button>
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
  let trackId = 0;

  // octave-corrected count-in tempo of a track (×2/÷2 buttons set t.octave)
  const trackBpm = (t) => t.analysis.countin.bpm * (t.octave || 1);
  // tracks whose SOUND goes into the mix: have a count-in, not muted, and not a
  // video that's paired to another take (those contribute only their picture).
  const soundTracksOf = () => state.tracks.filter(
    (t) => t.analysis && t.analysis.countin && !t.mute && !t.pairedWith);

  const medianBpm = () => {
    const bpms = soundTracksOf().map(trackBpm).sort((a, b) => a - b);
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
    const track = { name, mono, analysis, nudge: 0, mute: false, octave: 1, pairedWith: null,
                    searchStart: 0, id: ++trackId, videoBlob, videoExt, hasVideo: !!videoBlob,
                    fromRec, recVideo, color: COLORS[state.tracks.length % COLORS.length] };
    state.tracks.push(track);
    const row = makeTrackRow(track, {
      onNudge: () => recompute(),
      onMute: () => recompute(),
      onOctave: (f) => { track.octave = Math.min(4, Math.max(0.25, (track.octave || 1) * f)); recompute(); },
      onPair: (val) => { track.pairedWith = val ? Number(val) : null; recompute(); },
      onRemove: () => { state.tracks = state.tracks.filter((t) => t !== track); row.remove(); recompute(); },
      onRetake: async () => {           // discard this take and record a fresh one
        state.tracks = state.tracks.filter((t) => t !== track); row.remove();
        await recompute();
        await startRec(track.recVideo);
      },
      onSetStart: (t, view) => {        // click the waveform: "count-in starts here"
        if (view && view !== "raw") return;
        track.searchStart = t < 0.15 ? 0 : t;   // click far left to reset
        track.analysis = analyzeTake(track.mono, SR, { fromTime: track.searchStart });
        recompute();
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

  // build the warp curve for a track straightened onto `period`. Beats are
  // re-tracked at the octave-corrected tempo when ×2/÷2 is used.
  function trackWarp(t, period) {
    const a = t.analysis, ci = a.countin;
    const anchor = state.keepCountin ? ci.counts[0] : a.downbeat;
    let beats = a.beats;
    if ((t.octave || 1) !== 1)
      beats = trackBeats(trimToDownbeat(t.mono, a.downbeat), trackBpm(t)).map((x) => x + a.downbeat);
    // include the four count beats when keeping the count-in (a.beats starts at
    // the downbeat). Each beat is snapped to its grid slot by the take's own beat
    // period, so a near-downbeat duplicate can't shove the start over a beat.
    const absBeats = state.keepCountin ? [...ci.counts, ci.downbeat, ...beats] : [a.downbeat, ...beats];
    const rel = absBeats.map((b) => b - anchor).filter((b) => b >= -1e-6);
    return { warp: straightenCurve(rel, period, 60 / trackBpm(t)), anchor };
  }

  function alignedAudio(t, warp, anchor, period) {
    let warped = warpStretch(trimToDownbeat(t.mono, anchor), warp);
    if (t.nudge) warped = nudgeShift(warped, t.nudge, period, SR);
    return warped;
  }

  async function recompute() {
    const sound = soundTracksOf();
    $(".bpm-auto").textContent = medianBpm() ? `${medianBpm().toFixed(0)} bpm` : "–";
    if (!sound.length) { state.mix = null; drawMaster(); $(".render-vid").hidden = true; refreshAll(); setStatus("load or record takes with a count-in"); return; }
    const target = state.targetBpm || medianBpm();
    const period = 60 / target;
    state.period = period;
    setStatus("straightening & mixing …");
    await new Promise((r) => setTimeout(r, 10));

    // phase 1 — straighten + mix the sound tracks
    const stems = [];
    for (const t of sound) {
      const { warp, anchor } = trackWarp(t, period);
      t._warpFn = warp; t._anchor = anchor;
      t._aligned = alignedAudio(t, warp, anchor, period);
      stems.push(t._aligned);
    }
    state.mix = mixStems(stems);

    // phase 2 — a paired video take borrows its sound take's EXACT warp curve
    // (anchored at its own count-in), so its picture stays in sync with that
    // take's sound even though it sounds different and isn't in the mix.
    for (const t of state.tracks) {
      if (!t.pairedWith || !t.hasVideo || !(t.analysis && t.analysis.countin)) continue;
      const partner = state.tracks.find((p) => p.id === t.pairedWith);
      if (partner && partner._warpFn) {
        t._warpFn = partner._warpFn; t._anchor = t.analysis.downbeat;
        t._aligned = alignedAudio(t, partner._warpFn, t._anchor, period);
      } else { t._warpFn = null; t._aligned = null; }
    }

    drawMaster();
    $(".render-vid").hidden = !state.tracks.some((t) => t.hasVideo && t._warpFn && !t.mute);
    refreshAll();
    dumpDiag(target, period);
    setStatus(`mixed ${sound.length} take(s) @ ${target.toFixed(0)} bpm — ${(state.mix.length / SR).toFixed(1)}s`);
  }

  // Under-the-hood diagnostic: logged to the console after every mix (and left on
  // window.__jamDiag). Copy the "JAM-DIAG …" line to inspect what the warp did —
  // notably the gap from the downbeat to the first played note (is a pause real
  // in the take, or inserted by warping?) and the warp anchors take→grid.
  function dumpDiag(target, period) {
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const diag = {
      targetBpm: Math.round(target * 10) / 10, periodMs: Math.round(period * 1000),
      keepCountin: state.keepCountin, mixDurS: r3(state.mix.length / SR),
      tracks: state.tracks.filter((t) => t.analysis && t.analysis.countin).map((t) => {
        const a = t.analysis, ci = a.countin, beatsAbs = a.beats || [];
        const firstPlay = (a.onsetTimes || []).find((o) => o > a.downbeat + 0.02);
        return {
          name: t.name, oct: t.octave, nudge: t.nudge, paired: t.pairedWith || null,
          searchStart: r3(t.searchStart || 0),
          bpm: Math.round(ci.bpm * 10) / 10, downbeat: r3(ci.downbeat), counts: ci.counts.map(r3),
          firstPlayedOnset: firstPlay != null ? r3(firstPlay) : null,
          gapDownbeatToFirstPlayMs: firstPlay != null ? Math.round((firstPlay - a.downbeat) * 1000) : null,
          nBeats: beatsAbs.length,
          beatIoisMs: beatsAbs.slice(1, 13).map((b, i) => Math.round((b - beatsAbs[i]) * 1000)),
          warpTakeS: t._warpFn ? Array.from(t._warpFn.xs).slice(0, 12).map(r3) : null,
          warpGridS: t._warpFn ? Array.from(t._warpFn.ys).slice(0, 12).map(r3) : null,
          alignedDurS: t._aligned ? r3(t._aligned.length / SR) : null,
        };
      }),
    };
    window.__jamDiag = diag;
    try { console.log("JAM-DIAG " + JSON.stringify(diag)); } catch (e) {}
  }

  function refreshAll() {
    const view = $(".view-aligned").checked ? "aligned" : "raw";
    const durs = state.tracks.map((t) => (view === "aligned" && t._aligned ? t._aligned.length : t.mono.length) / SR);
    const span = durs.length ? Math.max(...durs) : 0;
    // populate the "pair this video with a sound take" selects
    state.tracks.forEach((t) => {
      if (!t.hasVideo || !t._pairSelect) return;
      t._pairSelect.innerHTML = "";
      const add = (v, txt) => { const o = document.createElement("option"); o.value = v; o.textContent = txt; t._pairSelect.appendChild(o); };
      add("", "🎥+🔊 own sound");
      for (const o of state.tracks)
        if (o !== t && !o.hasVideo && o.analysis && o.analysis.countin) add(String(o.id), `🎥→ ${o.name}`);
      t._pairSelect.value = t.pairedWith ? String(t.pairedWith) : "";
    });
    state.tracks.forEach((t) => refreshTrackRow(t, SR, {
      view, spanDur: span, period: state.period, keepCountin: state.keepCountin,
    }));
  }

  function drawMaster(playheadT = null) {
    if (!state.mix) { const c = masterCanvas.getContext("2d"); c.clearRect(0, 0, masterCanvas.width, masterCanvas.height); return; }
    drawWaveform(masterCanvas, state.mix, SR, { playheadT });
  }

  // synthetic metronome on the detected grid (k*period), accent every 4th (the
  // "1"), so you can HEAR where the engine placed the beats/downbeats.
  function metronomeBuffer(len, period) {
    const m = new Float32Array(len);
    const ping = (at, freq) => {
      const i = Math.round(at * SR), L = Math.round(0.02 * SR);
      for (let j = 0; j < L && i + j < len; j++) m[i + j] += 0.5 * Math.exp(-30 * j / L) * Math.sin(2 * Math.PI * freq * j / SR);
    };
    let k = 0;
    for (let t = 0; t < len / SR; t += period) { ping(t, k % 4 === 0 ? 2000 : 1300); k++; }
    return m;
  }
  function playBuffer() {
    if (!state.mix) return null;
    if (!state.metro || !state.period) return state.mix;
    const m = metronomeBuffer(state.mix.length, state.period);
    const out = new Float32Array(state.mix.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-0.97, Math.min(0.97, state.mix[i] + 0.4 * m[i]));
    return out;
  }

  const setPlaying = (p) => rootEl.classList.toggle("playing", p);
  state.transport.onTime = (t) => drawMaster(t);
  state.transport.onEnd = () => { $(".play").textContent = "▶ Play mix"; setPlaying(false); };

  function startPlay() { const buf = playBuffer(); if (!buf) return; state.transport.play(buf, SR); $(".play").textContent = "■ Stop"; setPlaying(true); }
  function stopPlay() { state.transport.stop(); $(".play").textContent = "▶ Play mix"; setPlaying(false); }

  $(".play").onclick = () => { if (state.transport.playing) stopPlay(); else startPlay(); };
  $(".metro").onchange = (e) => { state.metro = e.target.checked; if (state.transport.playing) startPlay(); };
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
