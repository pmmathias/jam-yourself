"""Tiled render smoke test with generated inputs."""
import subprocess

from jamyourself import render


def _mk_video(path, dur=6.0):
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i",
         f"testsrc=size=464x832:rate=30:duration={dur}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)],
        capture_output=True, check=True)


def _mk_audio(path, dur=6.0):
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i",
         f"sine=frequency=440:duration={dur}", "-c:a", "aac", str(path)],
        capture_output=True, check=True)


def test_two_up_render(tmp_path):
    v1, v2 = tmp_path / "a.mp4", tmp_path / "b.mp4"
    au = tmp_path / "m.m4a"
    _mk_video(v1, 6.0)
    _mk_video(v2, 7.0)
    _mk_audio(au, 6.5)

    out = tmp_path / "out.mp4"
    info = render.render_tiles([str(v1), str(v2)], str(au), str(out),
                               fade_in=1, fade_out=1)
    assert out.exists() and out.stat().st_size > 0
    assert info["size"] == "928x832"
    assert abs(info["duration"] - 6.5) < 0.2   # master mix defines length
