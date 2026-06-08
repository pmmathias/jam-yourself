"""End-to-end: turn several phone takes + a master mix into one tiled video
where you see yourself playing every instrument but hear the clean master mix.

For each take we align its (own, unamplified) audio to the master mix in the
instrument's frequency band, derive the tempo-warp curve, warp the take's video
onto the master timeline, then tile everything with the master mix as audio.
"""
import os
import tempfile

from .engine import align_follower, load_mono, residual_lag_curve, SR
from .render import render_tiles
from .video import warp_video


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
