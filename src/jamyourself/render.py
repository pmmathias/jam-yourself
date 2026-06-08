"""Tile N (already warped, already aligned) video streams side by side and lay
the master mix under them as the soundtrack.

All inputs are assumed to start at musical t=0 (each was trimmed to its own
count-in downbeat and warped onto the master timeline), so they are simply
stacked and played together. The audio you hear is the clean master mix.
"""
import math
import subprocess


def _duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def _grid_layout(n, cell_w, cell_h):
    """Return (cols, rows, layout_string) for ffmpeg xstack with uniform cells."""
    cols = n if n <= 3 else math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    entries = []
    for i in range(n):
        c, r = i % cols, i // cols
        x = "0" if c == 0 else "+".join(["w0"] * c)
        y = "0" if r == 0 else "+".join(["h0"] * r)
        entries.append(f"{x}_{y}")
    return cols, rows, "|".join(entries)


def render_tiles(videos, master_audio, out_path, cell_w=464, cell_h=832,
                 fps=30, fade_in=2.0, fade_out=2.0, crf=20, preset="medium"):
    """Render tiled video with the master mix as audio.

    videos: list of warped, aligned video paths. Returns dict with diagnostics.
    """
    n = len(videos)
    if n == 0:
        raise ValueError("need at least one video")
    dur = min([_duration(v) for v in videos] + [_duration(master_audio)])

    cols, rows, layout = _grid_layout(n, cell_w, cell_h)

    parts = []
    for i in range(n):
        parts.append(
            f"[{i}:v]scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease,"
            f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]")
    if n == 1:
        stack = "[v0]copy[grid]"
    else:
        stack = "".join(f"[v{i}]" for i in range(n)) + \
                f"xstack=inputs={n}:layout={layout}[grid]"
    vfade = (f"[grid]fade=t=in:st=0:d={fade_in},"
             f"fade=t=out:st={dur - fade_out}:d={fade_out},"
             f"format=yuv420p[vout]")
    afade = (f"[{n}:a]afade=t=in:st=0:d={fade_in},"
             f"afade=t=out:st={dur - fade_out}:d={fade_out}[aout]")
    filter_complex = ";".join(parts + [stack, vfade, afade])

    cmd = ["ffmpeg", "-y"]
    for v in videos:
        cmd += ["-i", v]
    cmd += ["-i", master_audio,
            "-filter_complex", filter_complex,
            "-map", "[vout]", "-map", "[aout]",
            "-t", f"{dur:.4f}",
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-pix_fmt", "yuv420p", "-r", str(fps),
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart", out_path]
    subprocess.run(cmd, capture_output=True, check=True)
    return {"out": out_path, "n": n, "cols": cols, "rows": rows,
            "duration": dur, "size": f"{cols*cell_w}x{rows*cell_h}"}
