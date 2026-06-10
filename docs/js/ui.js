// Canvas waveform rendering with count-in / downbeat / beat-grid overlays,
// and the per-track row DOM. The "see your tracks" part.

const COL = {
  wave: "#22d3ee",                  // cyan-400
  count: "#fb7185",                 // rose-400
  downbeat: "#f59e0b",              // amber-500
  beat: "rgba(255,255,255,0.10)",
  playhead: "#67e8f9",              // cyan-300
  grid: "rgba(255,255,255,0.05)",
};

export function drawWaveform(canvas, mono, sr, markers = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const monoDur = mono.length / sr;
  const dur = markers.spanDur || monoDur;     // shared time span across tracks
  const tx = (t) => (t / dur) * w;
  const mid = h / 2;

  // beat grid (drawn across the whole span)
  if (markers.beats) {
    ctx.strokeStyle = COL.beat; ctx.lineWidth = 1;
    for (const b of markers.beats) {
      const x = tx(b); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  // waveform peaks (occupies only its own duration within the span)
  const waveW = Math.max(1, Math.round(tx(monoDur)));
  const spp = mono.length / waveW;
  ctx.strokeStyle = COL.wave; ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
  ctx.beginPath();
  for (let x = 0; x < waveW; x++) {
    let min = 1, max = -1;
    const s = Math.floor(x * spp), e = Math.min(mono.length, Math.floor((x + 1) * spp));
    for (let i = s; i < e; i++) { const v = mono[i]; if (v < min) min = v; if (v > max) max = v; }
    ctx.moveTo(x + 0.5, mid - max * mid * 0.95);
    ctx.lineTo(x + 0.5, mid - min * mid * 0.95);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  const vline = (t, color, lw) => {
    const x = tx(t); ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  };
  if (markers.searchStart) {              // manual "count-in starts here" marker
    ctx.setLineDash([5, 4]); vline(markers.searchStart, "#e879f9", 2); ctx.setLineDash([]);
  }
  if (markers.counts) markers.counts.forEach((t) => vline(t, COL.count, 2));
  if (markers.downbeat != null) vline(markers.downbeat, COL.downbeat, 3);
  if (markers.playheadT != null && markers.playheadT > 0) vline(markers.playheadT, COL.playhead, 2);
}

export function makeTrackRow(track, cb) {
  const row = document.createElement("div");
  row.className = "track";
  row.innerHTML = `
    <div class="track-head">
      <span class="dot" style="background:${track.color}"></span>
      <span class="name" title="${track.name}">${track.name}</span>
      <span class="badge bpm">–</span>
      <span class="badge db">–</span>
      <span class="badge vid" hidden>🎥</span>
      <select class="pair" title="use this video for which take's sound?" hidden></select>
      <div class="spacer"></div>
      <div class="oct">
        <button class="oct-half" title="half tempo (fix octave)">÷2</button>
        <span class="oct-val" hidden></span>
        <button class="oct-double" title="double tempo (fix octave)">×2</button>
      </div>
      <div class="nudge">
        <button class="nminus" title="shift one beat earlier">−</button>
        <span class="nval">0</span><small>beat</small>
        <button class="nplus" title="shift one beat later">+</button>
      </div>
      <button class="retake" title="discard & record again" hidden>↻ again</button>
      <button class="mute" title="mute">M</button>
      <button class="remove" title="remove">✕</button>
    </div>
    <canvas class="wave"></canvas>`;
  const canvas = row.querySelector(".wave");
  canvas.style.cursor = "crosshair";
  canvas.title = "click to mark where the count-in starts (skip leading noise); click far left to reset";
  canvas.onclick = (e) => {
    const rect = canvas.getBoundingClientRect();
    const t = (e.clientX - rect.left) / rect.width * (track._drawSpan || 0);
    cb.onSetStart && cb.onSetStart(t, track._drawView);
  };
  const nval = row.querySelector(".nval");
  row.querySelector(".nminus").onclick = () => { track.nudge--; nval.textContent = track.nudge; cb.onNudge(); };
  row.querySelector(".nplus").onclick = () => { track.nudge++; nval.textContent = track.nudge; cb.onNudge(); };
  const muteBtn = row.querySelector(".mute");
  muteBtn.onclick = () => { track.mute = !track.mute; muteBtn.classList.toggle("on", track.mute); cb.onMute(); };
  row.querySelector(".retake").onclick = () => cb.onRetake && cb.onRetake();
  row.querySelector(".remove").onclick = () => cb.onRemove();
  row.querySelector(".oct-half").onclick = () => cb.onOctave && cb.onOctave(0.5);
  row.querySelector(".oct-double").onclick = () => cb.onOctave && cb.onOctave(2);
  const pairSel = row.querySelector(".pair");
  pairSel.onchange = () => cb.onPair && cb.onPair(pairSel.value);
  track._row = row; track._canvas = canvas;
  track._bpmBadge = row.querySelector(".bpm");
  track._dbBadge = row.querySelector(".db");
  track._vidBadge = row.querySelector(".vid");
  track._retakeBtn = row.querySelector(".retake");
  track._pairSelect = pairSel;
  track._octVal = row.querySelector(".oct-val");
  return row;
}

export function refreshTrackRow(track, sr, opts = {}) {
  const a = track.analysis;
  track._bpmBadge.textContent = a && a.countin ? `${a.countin.bpm.toFixed(0)} bpm` : "no count-in";
  track._dbBadge.textContent = a && a.downbeat != null ? `↓ ${a.downbeat.toFixed(2)}s` : "";
  track._vidBadge.hidden = !track.hasVideo;
  track._retakeBtn.hidden = !track.fromRec;
  track._pairSelect.hidden = !track.hasVideo;
  const oct = track.octave || 1;
  track._octVal.hidden = oct === 1;
  track._octVal.textContent = oct === 1 ? "" : (oct > 1 ? `×${oct}` : `÷${Math.round(1 / oct)}`);
  track._row.querySelector(".nval").textContent = track.nudge;

  track._drawView = opts.view || "raw";
  track._drawSpan = opts.spanDur || (track.mono.length / sr);

  if (opts.view === "aligned" && track._aligned) {
    // warped audio against the SHARED common-tempo grid: downbeats line up,
    // onsets should sit on the grid lines -> visual proof the warp happened.
    const period = opts.period, span = opts.spanDur || track._aligned.length / sr;
    const grid = [];
    for (let t = 0; t <= span + 1e-6; t += period) grid.push(t);
    const base = opts.keepCountin ? 4 : 0;     // downbeat is 4 beats after count 1
    const downbeat = (base + track.nudge) * period;
    const counts = opts.keepCountin ? [0, 1, 2, 3].map((k) => (k + track.nudge) * period) : [];
    drawWaveform(track._canvas, track._aligned, sr, { spanDur: span, beats: grid, downbeat, counts });
  } else {
    drawWaveform(track._canvas, track.mono, sr, {
      spanDur: opts.spanDur,
      counts: a && a.countin ? a.countin.counts : [],
      downbeat: a ? a.downbeat : null,
      beats: a ? a.beats : [],
      searchStart: track.searchStart || 0,
    });
  }
}
