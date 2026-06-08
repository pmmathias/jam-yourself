"""jam-yourself command-line interface.

    jam-yourself --master mix.mp3 --out jam.mp4 \\
        --take drums.mp4:150:6000 \\
        --take bass.mp4:40:300

Each --take is  VIDEO[:LO:HI]  where LO/HI is the instrument's frequency band in
Hz (optional but strongly recommended for clean alignment).
"""
import argparse
import sys

from .pipeline import make_jam


def _parse_take(spec):
    parts = spec.split(":")
    path = parts[0]
    band = None
    if len(parts) == 3:
        band = (float(parts[1]), float(parts[2]))
    elif len(parts) != 1:
        raise argparse.ArgumentTypeError(
            f"bad --take '{spec}', expected VIDEO[:LO:HI]")
    label = path.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return {"video": path, "band": band, "label": label}


def main(argv=None):
    ap = argparse.ArgumentParser(prog="jam-yourself",
                                 description="Tile multi-instrument takes under "
                                             "a master mix, without a click track.")
    ap.add_argument("--master", required=True, help="master mix audio (the sound)")
    ap.add_argument("--take", action="append", required=True, type=_parse_take,
                    dest="takes", help="VIDEO[:LO:HI], repeatable")
    ap.add_argument("--out", default="jam.mp4")
    ap.add_argument("--bin", type=float, default=0.5,
                    help="warp-curve smoothing window in s (smaller = tighter)")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--work-dir", default=None,
                    help="keep intermediate warped videos here")
    args = ap.parse_args(argv)

    info = make_jam(args.master, args.takes, args.out, work_dir=args.work_dir,
                    bin_s=args.bin, fps=args.fps)
    print(f"\n✓ {info['out']}  ({info['render']['size']}, "
          f"{info['render']['duration']:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
