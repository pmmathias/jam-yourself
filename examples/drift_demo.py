"""Showcase the tempo-warp on REAL video: deliberately drift a take, then let
jam-yourself re-lock it.

We take a clean bass take, apply a KNOWN tempo drift to its picture *and* sound
(simulating a take that wandered in tempo without a click), align the drifted
take back to the clean one, and warp its video by the recovered curve. The
output is a 3-up comparison you can watch:

    [ clean (reference) | drifted (slips out) | jam-yourself corrected (locked) ]

all playing the clean bass audio -- so the middle tile visibly drifts against
the sound while the right tile stays in sync.

Usage:
    python examples/drift_demo.py BASS.mp4 OUTDIR
"""
import os
import subprocess
import sys

import numpy as np
import soundfile as sf
from scipy.interpolate import PchipInterpolator

from jamyourself import engine as we
from jamyourself.render import render_tiles
from jamyourself.video import warp_video


def drift_curve(dur, amp=0.20, period=15.0):
    t = np.linspace(0, dur, 400)
    w = np.maximum.accumulate(t + amp * np.sin(2 * np.pi * t / period))
    return PchipInterpolator(t, w, extrapolate=True)


def make_drifted_take(src_video, out_video, workdir):
    audio = we.load_mono(src_video)
    fn = drift_curve(len(audio) / we.SR)
    drift_v = os.path.join(workdir, "drift_v.mp4")
    drift_a = os.path.join(workdir, "drift_a.wav")
    warp_video(src_video, fn, drift_v)
    sf.write(drift_a, we.warp_audio(audio, fn), we.SR)
    subprocess.run(
        ["ffmpeg", "-y", "-i", drift_v, "-i", drift_a,
         "-c:v", "copy", "-c:a", "aac", "-shortest", out_video],
        capture_output=True, check=True)
    return out_video


def _rms(a, b):
    _, lag = we.residual_lag_curve(a, b, search=0.25, min_conf=2.0)
    return float(np.sqrt((lag ** 2).mean())) if len(lag) else float("nan")


def main():
    bass, outdir = sys.argv[1:3]
    work = os.path.join(outdir, "_work")
    os.makedirs(work, exist_ok=True)

    print("creating deliberately drifted bass take (+/-200ms, 15s period) ...")
    drifted = make_drifted_take(bass, os.path.join(outdir, "bass_drifted.mp4"), work)

    print("aligning drifted take back to the clean one ...")
    clean_y = we.load_mono(bass)
    drift_y = we.load_mono(drifted)
    before = _rms(clean_y, drift_y)
    rec_y, diag = we.align_follower(clean_y, drift_y, band=None, bin_s=0.4)
    after = _rms(clean_y, rec_y)
    print(f"  drift {before:.0f}ms -> {after:.0f}ms "
          f"({100 * (1 - after / before):.0f}% removed)")

    print("warping the drifted video by the recovered curve ...")
    recovered = os.path.join(outdir, "bass_recovered.mp4")
    warp_video(drifted, diag["warp_fn"], recovered)

    print("rendering 3-up comparison (clean | drifted | corrected) ...")
    out = os.path.join(outdir, "jam_drift_demo.mp4")
    info = render_tiles([bass, drifted, recovered], bass, out)
    print(f"\n✓ {out}  ({info['size']}, {info['duration']:.1f}s)")
    print("  left = clean ref | middle = drifted (slips) | right = corrected (locked)")


if __name__ == "__main__":
    main()
