"""End-to-end: turn several phone takes + a master mix into one tiled video
where you see yourself playing every instrument but hear the clean master mix.

For each take we align its (own, unamplified) audio to the master mix in the
instrument's frequency band, derive the tempo-warp curve, warp the take's video
onto the master timeline, then tile everything with the master mix as audio.
"""
import os
import tempfile

import numpy as np

from .countin import detect_countin, trim_to_downbeat
from .engine import align_follower, load_mono, residual_lag_curve, SR
from .grid import straighten_to_grid
from .render import render_tiles
from .video import warp_video


def mix_stems(signals, target_rms=0.12):
    """RMS-match each stem to a common loudness, sum, peak-limit."""
    leveled = [s * (target_rms / (float(np.sqrt((s ** 2).mean())) + 1e-9))
               for s in signals]
    n = min(len(s) for s in leveled)
    m = np.sum([s[:n] for s in leveled], axis=0)
    peak = float(np.abs(m).max()) + 1e-9
    return (m * (0.97 / peak) if peak > 0.97 else m).astype(np.float32)


def make_audio_jam(paths, target_bpm=None, log=print):
    """Count-in anchor + beat-grid straighten + mix several audio takes.

    Each take is counted in percussively; we detect its downbeat, trim to it so
    all takes start at musical t=0, then warp each onto a steady common-tempo
    grid so they stay locked for the whole take. Returns (mix, diagnostics)."""
    trimmed, bpms = [], []
    for p in paths:
        y = load_mono(p)
        r = detect_countin(y)
        log(f"{os.path.basename(p):24s} downbeat={r['downbeat']:.3f}s "
            f"bpm={r['bpm']:.1f} conf={r['confidence']:.2f}")
        trimmed.append(( y, trim_to_downbeat(y, r["downbeat"]), r["bpm"] ))
        bpms.append(r["bpm"])

    target_period = 60.0 / (target_bpm or float(np.median(bpms)))
    log(f"target tempo: {60.0 / target_period:.1f} bpm")

    straightened = []
    for p, (_, yt, bpm) in zip(paths, trimmed):
        yw, d = straighten_to_grid(yt, target_period, start_bpm=bpm)
        log(f"{os.path.basename(p):24s} {d['n_beats']} beats -> steady grid")
        straightened.append(yw)

    return mix_stems(straightened), {"target_bpm": 60.0 / target_period,
                                     "n_takes": len(paths)}


def _rms_lag(a, b, band):
    import numpy as np
    _, lag = residual_lag_curve(a, b, band=band, search=0.25, min_conf=2.0)
    return float(np.sqrt((lag ** 2).mean())) if len(lag) else float("nan")


def make_jam(master_audio, takes, out_path, work_dir=None, bin_s=0.5,
             fps=30, log=print):
    """takes: list of dicts {'video': path, 'band': (lo, hi) | None,
    'label': str | None}. Returns diagnostics dict."""
    work_dir = work_dir or tempfile.mkdtemp(prefix="jamyourself_")
    os.makedirs(work_dir, exist_ok=True)
    master_y = load_mono(master_audio)

    warped_videos, per_take = [], []
    for i, take in enumerate(takes):
        label = take.get("label") or f"take{i}"
        band = take.get("band")
        log(f"[{label}] aligning to master (band={band}) …")
        take_y = load_mono(take["video"])
        before = _rms_lag(master_y, take_y, band)
        warped_y, diag = align_follower(master_y, take_y, band=band,
                                        bin_s=bin_s, verbose=False)
        after = _rms_lag(master_y, warped_y, band)
        log(f"[{label}] drift {before:.0f}ms -> {after:.0f}ms  "
            f"(offset {diag['offset']:+.2f}s)")

        wpath = os.path.join(work_dir, f"warp_{i}_{label}.mp4")
        log(f"[{label}] warping video → {os.path.basename(wpath)} …")
        vinfo = warp_video(take["video"], diag["warp_fn"], wpath, fps=fps)
        warped_videos.append(wpath)
        per_take.append({"label": label, "band": band,
                         "drift_before_ms": before, "drift_after_ms": after,
                         "offset": diag["offset"], **vinfo})

    log(f"rendering tiled video → {out_path} …")
    rinfo = render_tiles(warped_videos, master_audio, out_path, fps=fps)
    log(f"done: {rinfo['size']}, {rinfo['duration']:.1f}s, "
        f"{rinfo['cols']}x{rinfo['rows']} grid")
    return {"out": out_path, "work_dir": work_dir, "takes": per_take,
            "render": rinfo}
