"""Tile N (already warped, already aligned) video streams and lay the master mix
under them as the soundtrack.

Each warped video carries master-clock timestamps (PTS), so a stem that started
late simply appears late. We overlay every tile onto a black background with
eof_action=pass, which preserves that alignment and shows black wherever a tile
has no frame yet -- robust to stems of different start time and length (xstack
would require every tile present in every frame and break on real material).
"""
import math
import subprocess


def _duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def _grid(n):
    cols = n if n <= 3 else math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    return cols, rows


def render_tiles(videos, master_audio, out_path, cell_w=464, cell_h=832,
                 fps=30, fade_in=2.0, fade_out=2.0, crf=20, preset="medium"):
    """Render tiled video with the master mix as the soundtrack."""
    n = len(videos)
    if n == 0:
        raise ValueError("need at least one video")
    dur = _duration(master_audio)               # the soundtrack defines length
    cols, rows = _grid(n)
    grid_w, grid_h = cols * cell_w, rows * cell_h

    chains = [f"color=c=black:s={grid_w}x{grid_h}:r={fps}:d={dur:.4f}[bg]"]
    for i in range(n):
        chains.append(
            f"[{i}:v]scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease,"
            f"pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]")
    prev = "bg"
    for i in range(n):
        c, r = i % cols, i // cols
        x, y = c * cell_w, r * cell_h
        nxt = "vout_pre" if i == n - 1 else f"t{i}"
        chains.append(
            f"[{prev}][v{i}]overlay={x}:{y}:eof_action=pass[{nxt}]")
        prev = nxt
    chains.append(
        f"[vout_pre]fade=t=in:st=0:d={fade_in},"
        f"fade=t=out:st={max(0, dur - fade_out):.4f}:d={fade_out},"
        f"format=yuv420p[vout]")
    chains.append(
        f"[{n}:a]afade=t=in:st=0:d={fade_in},"
        f"afade=t=out:st={max(0, dur - fade_out):.4f}:d={fade_out}[aout]")
    filter_complex = ";".join(chains)

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
            "duration": dur, "size": f"{grid_w}x{grid_h}"}
