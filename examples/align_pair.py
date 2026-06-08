"""Align one follower take onto a master take and write the result.

Usage:
    python examples/align_pair.py MASTER FOLLOWER [--band LO HI] [--out OUT.wav]

Example (drums as rhythmic master, bass warped onto it):
    python examples/align_pair.py drums.mp4 bass.mp4 --band 40 300 --out bass_aligned.wav
"""
import argparse

import numpy as np
import soundfile as sf

from clickless import engine as we


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("master")
    ap.add_argument("follower")
    ap.add_argument("--band", nargs=2, type=float, default=None,
                    metavar=("LO", "HI"), help="follower instrument band in Hz")
    ap.add_argument("--bin", type=float, default=0.5,
                    help="warp-curve smoothing window in s (smaller = tighter)")
    ap.add_argument("--out", default="follower_aligned.wav")
    args = ap.parse_args()

    band = tuple(args.band) if args.band else None
    print(f"master   = {args.master}")
    print(f"follower = {args.follower}  band={band}  bin={args.bin}s")

    m = we.load_mono(args.master)
    f = we.load_mono(args.follower)

    _, lag0 = we.residual_lag_curve(m, f, band=band, search=0.25, min_conf=2.0)
    warped, diag = we.align_follower(m, f, band=band, bin_s=args.bin, verbose=True)
    _, lag1 = we.residual_lag_curve(m, warped, band=band, search=0.25, min_conf=2.0)

    def rms(x):
        return float(np.sqrt((x ** 2).mean())) if len(x) else float("nan")

    print(f"\nmisalignment rms: {rms(lag0):.0f}ms -> {rms(lag1):.0f}ms")
    sf.write(args.out, warped, we.SR)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
