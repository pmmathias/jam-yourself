"""Video time-warp plumbing: a known stretch must change duration accordingly."""
import subprocess

import numpy as np
from scipy.interpolate import PchipInterpolator

from jamyourself import video as vid


def _make_testsrc(path, dur=8.0, fps=30):
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i",
         f"testsrc=size=320x240:rate={fps}:duration={dur}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        capture_output=True, check=True)


def test_linear_stretch_changes_duration(tmp_path):
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_testsrc(src, dur=8.0)

    factor = 1.05
    info = vid.warp_video(str(src), lambda t: factor * np.asarray(t),
                          str(out), fps=30)

    assert abs(info["out_dur"] - factor * info["in_dur"]) < 0.2, info
    assert info["poly_degree"] >= 1


def test_nonlinear_monotone_curve(tmp_path):
    src = tmp_path / "src.mp4"
    out = tmp_path / "out.mp4"
    _make_testsrc(src, dur=8.0)

    # smooth wobble around identity (like real drift), still monotone
    anchors_t = np.linspace(0, 8, 9)
    anchors_w = anchors_t + 0.1 * np.sin(2 * np.pi * anchors_t / 8)
    fn = PchipInterpolator(anchors_t, np.maximum.accumulate(anchors_w))

    info = vid.warp_video(str(src), fn, str(out), fps=30)
    assert info["out_dur"] > 0
    assert abs(info["out_dur"] - info["in_dur"]) < 0.5  # near-identity overall
