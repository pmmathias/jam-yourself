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

  const dur = mono.length / sr;
  const tx = (t) => (t / dur) * w;
  const mid = h / 2;

  // beat grid
  if (markers.beats) {
    ctx.strokeStyle = COL.beat; ctx.lineWidth = 1;
    for (const b of markers.beats) {
      const x = tx(b); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  // waveform peaks (one min/max bar per pixel column)
  const spp = mono.length / w;
  ctx.strokeStyle = COL.wave; ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
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
      <div class="spacer"></div>
      <div class="nudge">
        <button class="nminus" title="shift one beat earlier">−</button>
        <span class="nval">0</span><small>beat</small>
        <button class="nplus" title="shift one beat later">+</button>
      </div>
      <button class="mute" title="mute">M</button>
      <button class="remove" title="remove">✕</button>
    </div>
    <canvas class="wave"></canvas>`;
  const canvas = row.querySelector(".wave");
  const nval = row.querySelector(".nval");
  row.querySelector(".nminus").onclick = () => { track.nudge--; nval.textContent = track.nudge; cb.onNudge(); };
  row.querySelector(".nplus").onclick = () => { track.nudge++; nval.textContent = track.nudge; cb.onNudge(); };
  const muteBtn = row.querySelector(".mute");
  muteBtn.onclick = () => { track.mute = !track.mute; muteBtn.classList.toggle("on", track.mute); cb.onMute(); };
  row.querySelector(".remove").onclick = () => cb.onRemove();
  track._row = row; track._canvas = canvas;
  track._bpmBadge = row.querySelector(".bpm");
  track._dbBadge = row.querySelector(".db");
  return row;
}

export function refreshTrackRow(track, sr) {
  const a = track.analysis;
  track._bpmBadge.textContent = a && a.countin ? `${a.countin.bpm.toFixed(0)} bpm` : "no count-in";
  track._dbBadge.textContent = a && a.downbeat != null ? `↓ ${a.downbeat.toFixed(2)}s` : "";
  track._row.querySelector(".nval").textContent = track.nudge;
  drawWaveform(track._canvas, track.mono, sr, {
    counts: a && a.countin ? a.countin.counts : [],
    downbeat: a ? a.downbeat : null,
    beats: a ? a.beats : [],
    playheadT: null,
  });
}
