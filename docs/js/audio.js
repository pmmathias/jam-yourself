// Browser audio I/O: decode dropped files to mono Float32 at the engine SR,
// play buffers with a transport, and export a mix as a WAV blob.
import { SR } from "./dsp/constants.js";

let _ctx = null;
export function audioContext() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

// Decode an audio File/Blob to a mono Float32Array resampled to the engine SR.
export async function decodeToMono(file, sr = SR) {
  const arrayBuf = await file.arrayBuffer();
  const tmp = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
  const decoded = await tmp.decodeAudioData(arrayBuf);
  // mix to mono
  const ch = decoded.numberOfChannels;
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < ch; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / ch;
  }
  if (decoded.sampleRate === sr) return mono;
  // resample to sr via an offline render (proper, anti-aliased)
  const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
    1, Math.ceil((mono.length / decoded.sampleRate) * sr), sr);
  const buf = off.createBuffer(1, mono.length, decoded.sampleRate);
  buf.getChannelData(0).set(mono);
  const node = off.createBufferSource();
  node.buffer = buf; node.connect(off.destination); node.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}

// Transport: plays a mono Float32 buffer; reports playhead via onTime(t).
export class Transport {
  constructor() { this.ctx = audioContext(); this.src = null; this.startedAt = 0; this.raf = null; this.onTime = null; this.onEnd = null; }
  play(float32, sr = SR) {
    this.stop();
    const buf = this.ctx.createBuffer(1, float32.length, sr);
    buf.getChannelData(0).set(float32);
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.connect(this.ctx.destination);
    this.ctx.resume();
    src.start();
    this.src = src; this.startedAt = this.ctx.currentTime;
    src.onended = () => { if (this.src === src) { this.stop(); this.onEnd && this.onEnd(); } };
    const tick = () => {
      if (!this.src) return;
      this.onTime && this.onTime(this.ctx.currentTime - this.startedAt);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  stop() {
    if (this.src) { try { this.src.stop(); } catch (e) {} this.src.disconnect(); this.src = null; }
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    this.onTime && this.onTime(0);
  }
  get playing() { return !!this.src; }
}

// Encode a mono Float32 buffer to a 16-bit PCM WAV Blob.
export function wavBlob(float32, sr = SR) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true); off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}
