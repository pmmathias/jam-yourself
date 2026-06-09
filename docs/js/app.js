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
      <button class="play">▶ Play mix</button>
      <button class="download">⤓ WAV</button>
    </div>
    <div class="status"></div>
  </section>
  <section class="tracks"></section>
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

  async function addTrack(name, blob, { videoBlob = null } = {}) {
    setStatus(`decoding ${name} …`);
    let mono;
    try { mono = await decodeToMono(blob); }
    catch (e) { setStatus(`could not decode ${name}`); return; }
    setStatus(`analysing ${name} …`);
    const analysis = analyzeTake(mono);
    const track = { name, mono, analysis, nudge: 0, mute: false,
                    videoBlob, hasVideo: !!videoBlob,
                    color: COLORS[state.tracks.length % COLORS.length] };
    state.tracks.push(track);
    const row = makeTrackRow(track, {
      onNudge: () => recompute(),
      onMute: () => recompute(),
      onRemove: () => { state.tracks = state.tracks.filter((t) => t !== track); row.remove(); recompute(); },
    });
    tracksEl.appendChild(row);
    refreshTrackRow(track, SR);
  }

  async function addFiles(files) {
    for (const file of files) await addTrack(file.name, file);
    await recompute();
  }

  async function recompute() {
    $(".bpm-auto").textContent = medianBpm() ? `${medianBpm().toFixed(0)} bpm` : "–";
    const usable = state.tracks.filter((t) => t.analysis && t.analysis.countin && !t.mute);
    if (!usable.length) { state.mix = null; drawMaster(); setStatus("load or record takes with a count-in"); return; }
    const target = state.targetBpm || medianBpm();
    const period = 60 / target;
    setStatus("straightening & mixing …");
    await new Promise((r) => setTimeout(r, 10));
    const stems = [];
    for (const t of usable) {
      const a = t.analysis;
      const anchor = state.keepCountin ? a.countin.counts[0] : a.downbeat;
      const body = trimToDownbeat(t.mono, anchor);
      const beatsRel = [0, ...a.beats.map((b) => b - anchor).filter((b) => b > 0.05)];
      let warped = warpStretch(body, straightenCurve(beatsRel, period));
      if (t.nudge) warped = nudgeShift(warped, t.nudge, period, SR);
      stems.push(warped);
    }
    state.mix = mixStems(stems);
    drawMaster();
    setStatus(`mixed ${usable.length} take(s) @ ${target.toFixed(0)} bpm — ${(state.mix.length / SR).toFixed(1)}s`);
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
  $(".bpm-input").onchange = (e) => { const v = parseFloat(e.target.value); state.targetBpm = v > 0 ? v : null; recompute(); };

  // record from mic / camera
  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  recBtn.onclick = async () => {
    if (state.recording) {
      const { blob, hasVideo } = await recorder.stop();
      state.recording = false; recBtn.classList.remove("on"); recBtn.textContent = "● Record";
      $(".rec-meter").style.width = "0%";
      await addTrack(`take ${++recCount} (${hasVideo ? "cam" : "mic"})`, blob, { videoBlob: hasVideo ? blob : null });
      return;
    }
    const video = $(".rec-video").checked;
    try {
      await recorder.start({ video, onLevel: (p, t) => {
        $(".rec-meter").style.width = `${Math.min(100, p * 140)}%`;
        recBtn.textContent = `■ Stop ${fmtT(t)}`;
      } });
    } catch (e) { setStatus("microphone/camera permission denied or unavailable"); return; }
    state.recording = true; recBtn.classList.add("on"); recBtn.textContent = "■ Stop 0:00";
    setStatus("recording — count in 1-2-3-4, then play");
  };

  // drag & drop + file input
  const drop = $(".drop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $(".file").addEventListener("change", (e) => { if (e.target.files.length) addFiles([...e.target.files]); });

  const onResize = () => { state.tracks.forEach((t) => refreshTrackRow(t, SR)); drawMaster(); };
  window.addEventListener("resize", onResize);
  setStatus("drop or record your count-in takes to start");

  return function destroy() {
    try { state.transport.stop(); } catch (e) {}
    if (state.recording) recorder.stop().catch(() => {});
    window.removeEventListener("resize", onResize);
    rootEl.innerHTML = "";
  };
}
