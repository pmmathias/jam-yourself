"""Apply the audio-derived tempo-warp curve to a video's frames.

The same monotone warp curve f: follower_time -> master_time that we apply to a
take's audio must be applied to its picture, so hands/sticks stay locked to the
sound. We do this natively in ffmpeg: fit the curve as a polynomial and feed it
to the `setpts` filter (which rewrites each frame's timestamp), then `fps`
resamples to a constant rate on the new timeline (duplicating/dropping frames as
the warp requires). No per-frame Python decode, no extra codec dependency.
"""
import subprocess

import numpy as np


def _ffprobe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def build_setpts_expr(warp_fn, dur, max_deg=6):
    """Polynomial setpts expression for new_time(T) = warp_fn(T).

    Fits the *correction* warp_fn(t)-t (small, smooth) as a polynomial in T and
    returns 'T + <poly>'. Reduces the degree until the resulting curve is
    monotone over [0, dur] (out-of-order timestamps would corrupt the video)."""
    ts = np.linspace(0, dur, 600)
    corr = warp_fn(ts) - ts
    for deg in range(max_deg, 0, -1):
        coeffs = np.polyfit(ts, corr, deg)          # highest power first
        fitted = ts + np.polyval(coeffs, ts)
        if np.all(np.diff(fitted) > 0):             # monotone -> usable
            terms = ["T"]
            p = len(coeffs) - 1
            for c in coeffs:
                terms.append(f"({c:.10g})*pow(T,{p})")
                p -= 1
            return "+".join(terms), deg
    return "T", 0                                   # fall back to identity


def warp_video(in_path, warp_fn, out_path, fps=30, dur=None, crf=20,
               preset="medium"):
    """Write `in_path` retimed by `warp_fn` to `out_path` (video only, no audio).

    `dur` is the input duration to fit the curve over (probed if None)."""
    if dur is None:
        dur = _ffprobe_duration(in_path)
    expr, deg = build_setpts_expr(warp_fn, dur)
    vf = f"setpts='({expr})/TB',fps={fps}"
    cmd = [
        "ffmpeg", "-y", "-i", in_path,
        "-vf", vf, "-an",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p", "-r", str(fps),
        "-movflags", "+faststart", out_path,
    ]
    subprocess.run(cmd, capture_output=True, check=True)
    return {"out": out_path, "poly_degree": deg, "in_dur": dur,
            "out_dur": _ffprobe_duration(out_path)}
