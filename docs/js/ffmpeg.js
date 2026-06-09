// Lazy ffmpeg.wasm loader — vendored SAME-ORIGIN (docs/vendor/ffmpeg) so the
// worker (spawned via import.meta.url) and the single-threaded core load without
// any cross-origin / COOP-COEP headaches, and the app stays fully offline. The
// ~32 MB core is fetched only the first time a video render is requested; audio
// never leaves the browser.
let _ff = null;
let _util = null;
let _loading = null;

const url = (p) => new URL(p, import.meta.url).href;

async function utilMod() {
  if (!_util) _util = await import(url("../vendor/ffmpeg/util/index.js"));
  return _util;
}

export async function getFFmpeg({ onLog = null, onProgress = null } = {}) {
  if (_ff) return _ff;
  if (_loading) return _loading;
  _loading = (async () => {
    const { FFmpeg } = await import(url("../vendor/ffmpeg/ffmpeg/index.js"));
    const ff = new FFmpeg();
    if (onLog) ff.on("log", ({ message }) => onLog(message));
    if (onProgress) ff.on("progress", ({ progress }) => onProgress(progress));
    await ff.load({
      coreURL: url("../vendor/ffmpeg/core/ffmpeg-core.js"),
      wasmURL: url("../vendor/ffmpeg/core/ffmpeg-core.wasm"),
    });
    _ff = ff;
    return ff;
  })();
  return _loading;
}

export async function fetchFile(data) {
  const { fetchFile } = await utilMod();
  return fetchFile(data);
}

export function isLoaded() { return !!_ff; }
