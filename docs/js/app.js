// jam-yourself web app: load/record takes -> analyse (count-in + beats) ->
// straighten onto a common tempo grid -> nudge -> mix. All in the browser.
//
// Embeddable: `mountApp(rootEl)` builds its own DOM inside rootEl (scoped under
// the `.jy` class), so it drops into any page (e.g. a QuantenBlog component
// mount point) without touching global styles. Returns a destroy() function.
import { SR } from "./dsp/constants.js";
import { analyzeTake, straightenCurve } from "./dsp/engine.js";
import { onsetEnvelope } from "./dsp/onset.js";
import { ENV_FPS, HOP } from "./dsp/constants.js";
import { trimToDownbeat } from "./dsp/countin.js";
import { mixStems, nudge as nudgeShift } from "./dsp/mix.js";
import { warpStretch } from "./dsp/stretch.js";
import { decodeToMono, Transport, wavBlob } from "./audio.js";
import { makeTrackRow, refreshTrackRow, drawWaveform } from "./ui.js";
import { Recorder } from "./recorder.js";
import { renderTiledVideo } from "./videorender.js";
import * as store from "./store.js";

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
      <label class="chk lock" title="auto sub-beat lock: shift each take by its measured residual offset so transients line up"><input type="checkbox" class="tighten" checked /> 🔗 tighten</label>
      <label class="chk"><input type="checkbox" class="view-aligned" /> aligned view</label>
      <button class="play">▶ Play mix</button>
      <label class="chk"><input type="checkbox" class="metro" /> 🔊 click</label>
      <button class="download">⤓ WAV</button>
      <button class="render-vid lock" hidden>▶ Render video</button>
      <button class="clear lock" title="remove all takes">🗑</button>
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
                  keepCountin: false, tighten: true, targetBpm: null, recording: false };
  const recorder = new Recorder();
  let recCount = 0;
  let trackId = 0;

  // median PLAYED beat period of a take (falls back to the count-in tempo if no
  // beats). The count-in can be counted unevenly / at a different tempo than the
  // playing, so the common grid should follow how the take was actually PLAYED.
  const playedPeriod = (t) => {
    const b = (t.analysis && t.analysis.beats) || [];
    const iois = b.slice(1).map((x, i) => x - b[i]).filter((d) => d > 0.1).sort((a, b) => a - b);
    return iois.length ? iois[Math.floor(iois.length / 2)] : 60 / t.analysis.countin.bpm;
  };
  // played tempo, with the ×2/÷2 octave relabel applied
  const trackBpm = (t) => (60 / playedPeriod(t)) * (t.octave || 1);
  // tracks whose SOUND goes into the mix: have a count-in, not muted, and not a
  // video that's paired to another take (those contribute only their picture).
  const soundTracksOf = () => state.tracks.filter(
    (t) => t.analysis && t.analysis.countin && !t.mute && !t.pairedWith);

  const medianBpm = () => {
    const bpms = soundTracksOf().map(trackBpm).sort((a, b) => a - b);
    return bpms.length ? bpms[Math.floor(bpms.length / 2)] : null;
  };

  // persist the session (ordered pids + per-take settings + globals); blobs are
  // saved once per take in addTrack. Debounced.
  let metaTimer = null;
  function persistMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(() => {
      const perTrack = {};
      for (const t of state.tracks) {
        const partner = t.pairedWith != null ? state.tracks.find((p) => p.id === t.pairedWith) : null;
        perTrack[t.pid] = { nudge: t.nudge, octave: t.octave, mute: t.mute, bassify: t.bassify,
                            searchStart: t.searchStart, pairedPid: partner ? partner.pid : null };
      }
      store.saveMeta({ order: state.tracks.map((t) => t.pid),
                       settings: { keepCountin: state.keepCountin, tighten: state.tighten, targetBpm: state.targetBpm },
                       perTrack }).catch(() => {});
    }, 500);
  }

  async function addTrack(name, blob, opts = {}) {
    const { videoBlob = null, videoExt = "webm", fromRec = false, recVideo = false,
            restore = null } = opts;
    setStatus(`decoding ${name} …`);
    let mono;
    try { mono = await decodeToMono(blob); }
    catch (e) { setStatus(`could not decode ${name}`); return; }
    const searchStart = restore ? (restore.searchStart || 0) : 0;
    setStatus(`analysing ${name} …`);
    const analysis = analyzeTake(mono, SR, { fromTime: searchStart });
    const track = { name, mono, srcBlob: blob, analysis,
                    nudge: restore ? (restore.nudge || 0) : 0,
                    mute: restore ? !!restore.mute : false,
                    octave: restore ? (restore.octave || 1) : 1,
                    bassify: restore ? !!restore.bassify : false,
                    pairedWith: null, searchStart, id: ++trackId,
                    pid: (restore && restore.pid) || store.newPid(),
                    videoBlob, videoExt, hasVideo: !!videoBlob, fromRec, recVideo,
                    color: COLORS[state.tracks.length % COLORS.length] };
    state.tracks.push(track);
    if (!restore) store.saveBlob(track.pid, { srcBlob: blob, name, hasVideo: !!videoBlob, videoExt, fromRec, recVideo }).catch(() => {});
    const row = makeTrackRow(track, {
      onNudge: () => recompute(),
      onMute: () => recompute(),
      onOctave: (f) => { track.octave = Math.min(4, Math.max(0.25, (track.octave || 1) * f)); recompute(); },
      onBassify: () => { track.bassify = !track.bassify; recompute(); },
      onPair: (val) => { track.pairedWith = val ? Number(val) : null; recompute(); },
      onRemove: () => { state.tracks = state.tracks.filter((t) => t !== track); row.remove(); store.deleteBlob(track.pid).catch(() => {}); recompute(); },
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
    return track;
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
    // Always use the beats tracked at the (reliable) count-in tempo. The ×2/÷2
    // octave only RELABELS the take's tempo for the common-grid target (via
    // medianBpm/trackBpm); it must NOT re-track at a far-off tempo, which would
    // make the tracker fail and the warp fall apart.
    const beats = a.beats;
    const absBeats = state.keepCountin ? [...ci.counts, ci.downbeat, ...beats] : [a.downbeat, ...beats];
    const rel = absBeats.map((b) => b - anchor).filter((b) => b >= -1e-6);
    // Snap beats using the ACTUAL played period (median tracked beat interval),
    // not the count-in tempo — players count slightly off their playing tempo,
    // and snapping by the count-in period would progressively misassign slots.
    const iois = beats.slice(1).map((b, i) => b - beats[i]).filter((d) => d > 0.1).sort((x, y) => x - y);
    const expectedPeriod = iois.length ? iois[Math.floor(iois.length / 2)] : 60 / ci.bpm;
    t._expectedPeriod = expectedPeriod;
    return { warp: straightenCurve(rel, period, expectedPeriod), anchor };
  }

  function alignedAudio(t, warp, anchor, period) {
    let warped = warpStretch(trimToDownbeat(t.mono, anchor), warp, SR,
                             { pitchOctaves: t.bassify ? -1 : 0 });
    if (t.nudge) warped = nudgeShift(warped, t.nudge, period, SR);
    return warped;
  }

  // Shift a mono buffer by `samp` samples: >0 delays (pad front with zeros),
  // <0 advances (drop leading samples). Returns a new view/buffer.
  function shiftSamples(arr, samp) {
    if (!samp) return arr;
    if (samp > 0) { const o = new Float32Array(arr.length + samp); o.set(arr, samp); return o; }
    return arr.subarray(Math.min(-samp, arr.length));
  }

  // Auto sub-beat lock: tempo + beat grid are matched, but the warp can leave a
  // small constant per-take offset (anchor jitter, per-instrument onset phase,
  // stretch latency) that smears stacked transients. Cross-correlate each stem's
  // onset envelope against the first over the MUSIC region (skip the count-in)
  // within ±half a beat, and return the integer-sample shift that best aligns it.
  // Guarded: only shifts when the correlation peak clearly beats the no-shift
  // value, so dissimilar instruments (no shared onsets) are left alone.
  function tightenShifts(stems, period) {
    const shifts = stems.map(() => 0);
    if (!state.tighten || stems.length < 2) return shifts;
    const skip = Math.round((state.keepCountin ? 4 : 0) * period * SR); // past count-in
    const envs = stems.map((s) => onsetEnvelope(s.subarray(Math.min(skip, s.length)), SR));
    const ref = envs[0];
    const maxLag = Math.round(period * 0.5 * ENV_FPS);
    for (let k = 1; k < stems.length; k++) {
      const e = envs[k], n = Math.min(ref.length, e.length);
      const corr = (L) => { let s = 0; for (let i = Math.max(0, -L); i < n - Math.max(0, L); i++) s += ref[i] * e[i + L]; return s; };
      let best = -Infinity, bestL = 0, s0 = 0;
      for (let L = -maxLag; L <= maxLag; L++) { const s = corr(L); if (L === 0) s0 = s; if (s > best) { best = s; bestL = L; } }
      // sub-frame peak via parabolic interpolation around bestL
      let frac = bestL;
      if (bestL > -maxLag && bestL < maxLag) {
        const a = corr(bestL - 1), c = corr(bestL + 1), d = a - 2 * best + c;
        if (d < 0) frac = bestL + 0.5 * (a - c) / d;
      }
      if (best > 1.08 * Math.max(1e-9, s0)) shifts[k] = -Math.round(frac * HOP); // late stem -> advance
    }
    return shifts;
  }

  async function recompute() {
    persistMeta();
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
    // auto sub-beat lock: nudge each stem by its measured residual offset so
    // transients across takes line up (tempo+grid already match).
    const shifts = tightenShifts(stems, period);
    sound.forEach((t, k) => { t._tightenShift = shifts[k]; t._aligned = shiftSamples(t._aligned, shifts[k]); });
    state.mix = mixStems(sound.map((t) => t._aligned));

    // phase 2 — a paired video take borrows its sound take's EXACT warp curve
    // (anchored at its own count-in), so its picture stays in sync with that
    // take's sound even though it sounds different and isn't in the mix.
    for (const t of state.tracks) {
      if (!t.pairedWith || !t.hasVideo || !(t.analysis && t.analysis.countin)) continue;
      const partner = state.tracks.find((p) => p.id === t.pairedWith);
      if (partner && partner._warpFn) {
        t._warpFn = partner._warpFn; t._anchor = t.analysis.downbeat;
        t._aligned = shiftSamples(alignedAudio(t, partner._warpFn, t._anchor, period),
                                  partner._tightenShift || 0);
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
  // residual sub-beat phase between aligned stems: cross-correlate each sound
  // track's onset envelope against the FIRST sound track's, peak lag in ms.
  // If beats are truly grid-pinned these should be ~0; a consistent non-zero
  // lag means the warp left a per-track offset (anchor jitter / tracker phase /
  // stretch latency) — exactly the "loose common alignment" symptom.
  function xcorrLagsMs(period) {
    const sound = soundTracksOf().filter((t) => t._aligned);
    if (sound.length < 2) return null;
    const envs = sound.map((t) => onsetEnvelope(t._aligned, SR));
    const ref = envs[0];
    const maxLag = Math.round(period * 0.5 * ENV_FPS); // search ±half a beat
    const lagOf = (e) => {
      let best = -Infinity, bestL = 0;
      for (let L = -maxLag; L <= maxLag; L++) {
        let s = 0;
        const n = Math.min(ref.length, e.length);
        for (let i = Math.max(0, -L); i < n - Math.max(0, L); i++) s += ref[i] * e[i + L];
        if (s > best) { best = s; bestL = L; }
      }
      return Math.round((bestL / ENV_FPS) * 1000);
    };
    return sound.map((t, i) => ({ name: t.name, lagMs: i === 0 ? 0 : lagOf(envs[i]) }));
  }

  function dumpDiag(target, period) {
    const r3 = (x) => Math.round(x * 1000) / 1000;
    const diag = {
      targetBpm: Math.round(target * 10) / 10, periodMs: Math.round(period * 1000),
      keepCountin: state.keepCountin, mixDurS: r3(state.mix.length / SR),
      // residual sub-beat offset of each aligned stem vs the first (ms)
      stemLagsMs: xcorrLagsMs(period),
      tracks: state.tracks.filter((t) => t.analysis && t.analysis.countin).map((t) => {
        const a = t.analysis, ci = a.countin, beatsAbs = a.beats || [];
        const firstPlay = (a.onsetTimes || []).find((o) => o > a.downbeat + 0.02);
        return {
          name: t.name, oct: t.octave, nudge: t.nudge, paired: t.pairedWith || null,
          searchStart: r3(t.searchStart || 0),
          tightenMs: t._tightenShift ? Math.round((t._tightenShift / SR) * 1000) : 0,
          bpm: Math.round(ci.bpm * 10) / 10, playedBpm: t._expectedPeriod ? Math.round(600 / t._expectedPeriod) / 10 : null,
          downbeat: r3(ci.downbeat), counts: ci.counts.map(r3),
          firstPlayedOnset: firstPlay != null ? r3(firstPlay) : null,
          gapDownbeatToFirstPlayMs: firstPlay != null ? Math.round((firstPlay - a.downbeat) * 1000) : null,
          nBeats: beatsAbs.length,
          // FULL inter-beat-interval trajectory (ms): shows where the tracked
          // tempo drifts/latches across the whole take, not just the start.
          beatIoisMs: beatsAbs.slice(1).map((b, i) => Math.round((b - beatsAbs[i]) * 1000)),
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
  $(".tighten").onchange = (e) => { state.tighten = e.target.checked; recompute(); };
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

  $(".clear").onclick = async () => {
    if (state.transport.playing) stopPlay();
    state.tracks = []; tracksEl.innerHTML = "";
    try { await store.clearAll(); } catch (e) {}
    await recompute();
  };

  const onResize = () => { refreshAll(); drawMaster(); };
  window.addEventListener("resize", onResize);

  // restore persisted takes (IndexedDB) across reloads
  async function loadSession() {
    let meta, blobs;
    try { meta = await store.getMeta(); blobs = await store.getAllBlobs(); } catch (e) { return false; }
    if (!meta || !meta.order || !meta.order.length) return false;
    setStatus("restoring your takes …");
    for (const pid of meta.order) {
      const rec = blobs[pid]; if (!rec) continue;
      const pt = (meta.perTrack || {})[pid] || {};
      await addTrack(rec.name, rec.srcBlob, {
        videoBlob: rec.hasVideo ? rec.srcBlob : null, videoExt: rec.videoExt,
        fromRec: rec.fromRec, recVideo: rec.recVideo,
        restore: { pid, nudge: pt.nudge, octave: pt.octave, mute: pt.mute, bassify: pt.bassify, searchStart: pt.searchStart },
      });
    }
    const byPid = {}; state.tracks.forEach((t) => { byPid[t.pid] = t; });
    state.tracks.forEach((t) => {
      const pt = (meta.perTrack || {})[t.pid] || {};
      if (pt.pairedPid && byPid[pt.pairedPid]) t.pairedWith = byPid[pt.pairedPid].id;
    });
    if (meta.settings) {
      state.keepCountin = !!meta.settings.keepCountin; $(".keep-countin").checked = state.keepCountin;
      if (meta.settings.tighten != null) { state.tighten = !!meta.settings.tighten; $(".tighten").checked = state.tighten; }
      state.targetBpm = meta.settings.targetBpm || null;
      if (state.targetBpm) $(".bpm-input").value = state.targetBpm;
    }
    await recompute();
    return state.tracks.length > 0;
  }
  loadSession().then((restored) => {
    if (!restored) setStatus("drop or record your count-in takes to start");
  });

  return function destroy() {
    try { state.transport.stop(); } catch (e) {}
    if (state.recording) recorder.stop().catch(() => {});
    window.removeEventListener("resize", onResize);
    rootEl.innerHTML = "";
  };
}
