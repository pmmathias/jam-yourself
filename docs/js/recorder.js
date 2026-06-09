// Record a take straight from the device mic (or camera) via getUserMedia +
// MediaRecorder. Audio is used for the jam; a recorded video blob is kept for
// the (future) tiled-video render. Works on laptop and mobile over HTTPS.

export function supportedMime(video) {
  const cands = video
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  if (!window.MediaRecorder) return "";
  for (const t of cands) if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}

export class Recorder {
  constructor() { this.stream = null; this.rec = null; this.chunks = []; this.video = false; this._raf = null; this._meterCtx = null; this._t0 = 0; }

  async start({ video = false, onLevel = null } = {}) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error("getUserMedia unsupported");
    this.video = video;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video,
    });
    const mime = supportedMime(video);
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start();
    this._t0 = (performance && performance.now) ? performance.now() : Date.now();
    if (onLevel) this._meter(onLevel);
  }

  _meter(onLevel) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(this.stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) { const d = Math.abs(v - 128) / 128; if (d > peak) peak = d; }
      const now = (performance && performance.now) ? performance.now() : Date.now();
      onLevel(peak, (now - this._t0) / 1000);
      this._raf = requestAnimationFrame(tick);
    };
    this._meterCtx = ctx; tick();
  }

  async stop() {
    return new Promise((resolve) => {
      this.rec.onstop = () => {
        const type = this.rec.mimeType || (this.video ? "video/webm" : "audio/webm");
        const blob = new Blob(this.chunks, { type });
        this._cleanup();
        resolve({ blob, type, hasVideo: this.video });
      };
      this.rec.stop();
    });
  }

  _cleanup() {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._meterCtx) this._meterCtx.close().catch(() => {});
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this._raf = null; this._meterCtx = null;
  }
}
