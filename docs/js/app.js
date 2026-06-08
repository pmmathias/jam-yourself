// jam-yourself web app: load takes -> analyse (count-in + beats) -> straighten
// onto a common tempo grid -> nudge -> mix. All in the browser.
import { SR } from "./dsp/constants.js";
import { analyzeTake, straightenCurve } from "./dsp/engine.js";
import { trimToDownbeat } from "./dsp/countin.js";
import { mixStems, nudge as nudgeShift } from "./dsp/mix.js";
import { warpStretch } from "./dsp/stretch.js";
import { decodeToMono, Transport, wavBlob } from "./audio.js";
import { makeTrackRow, refreshTrackRow, drawWaveform } from "./ui.js";

const COLORS = ["#6ee7ff", "#ff5a5a", "#3ddc84", "#ffd166", "#c792ea", "#f78c6c"];

const state = {
  tracks: [],
  mix: null,
  transport: new Transport(),
  keepCountin: false,
  targetBpm: null, // null = auto (median)
};

const $ = (s) => document.querySelector(s);
const tracksEl = $("#tracks");
const statusEl = $("#status");
const masterCanvas = $("#master-wave");
const setStatus = (s) => { statusEl.textContent = s; };

function medianBpm() {
  const bpms = state.tracks.filter((t) => t.analysis && t.analysis.countin)
    .map((t) => t.analysis.countin.bpm).sort((a, b) => a - b);
  if (!bpms.length) return null;
  return bpms[Math.floor(bpms.length / 2)];
}

async function addFiles(files) {
  for (const file of files) {
    setStatus(`decoding ${file.name} …`);
    let mono;
    try { mono = await decodeToMono(file); }
    catch (e) { setStatus(`could not decode ${file.name}`); continue; }
    setStatus(`analysing ${file.name} …`);
    const analysis = analyzeTake(mono);
    const track = { name: file.name, mono, analysis, nudge: 0, mute: false,
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
  await recompute();
}

async function recompute() {
  $("#bpm-auto").textContent = medianBpm() ? `${medianBpm().toFixed(0)} bpm` : "–";
  const usable = state.tracks.filter((t) => t.analysis && t.analysis.countin && !t.mute);
  if (!usable.length) { state.mix = null; drawMaster(); setStatus("load takes with a count-in"); return; }
  const target = state.targetBpm || medianBpm();
  const period = 60 / target;

  setStatus("straightening & mixing …");
  await new Promise((r) => setTimeout(r, 10)); // let the status paint
  const stems = [];
  for (const t of usable) {
    const a = t.analysis;
    const anchor = state.keepCountin ? a.countin.counts[0] : a.downbeat;
    const body = trimToDownbeat(t.mono, anchor);
    const beatsRel = [0, ...a.beats.map((b) => b - anchor).filter((b) => b > 0.05)];
    const warp = straightenCurve(beatsRel, period);
    let warped = warpStretch(body, warp);
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

// ---- transport -------------------------------------------------------------
state.transport.onTime = (t) => drawMaster(t);
state.transport.onEnd = () => { $("#play").textContent = "▶ Play mix"; };

$("#play").onclick = () => {
  if (state.transport.playing) { state.transport.stop(); $("#play").textContent = "▶ Play mix"; return; }
  if (!state.mix) return;
  state.transport.play(state.mix, SR);
  $("#play").textContent = "■ Stop";
};
$("#download").onclick = () => {
  if (!state.mix) return;
  const url = URL.createObjectURL(wavBlob(state.mix, SR));
  const a = document.createElement("a"); a.href = url; a.download = "jam.wav"; a.click();
  URL.revokeObjectURL(url);
};
$("#keep-countin").onchange = (e) => { state.keepCountin = e.target.checked; recompute(); };
$("#bpm-input").onchange = (e) => {
  const v = parseFloat(e.target.value);
  state.targetBpm = v > 0 ? v : null;
  recompute();
};

// ---- drag & drop + file input ----------------------------------------------
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
$("#file").addEventListener("change", (e) => { if (e.target.files.length) addFiles([...e.target.files]); });

window.addEventListener("resize", () => { state.tracks.forEach((t) => refreshTrackRow(t, SR)); drawMaster(); });
setStatus("drop your count-in takes to start");
