"""Lock several separately recorded audio takes into one tight mix -- no click.

Each take is counted in percussively ("1-2-3-4"); jam-yourself detects each
take, warps it onto a steady common-tempo grid (so the takes start together AND
stay locked), optionally keeps the count-in audible, applies a per-take whole-
beat nudge, and mixes. Writes mix.wav.

Usage:
    python examples/audio_jam.py OUT_DIR TAKE1 TAKE2 [...] \\
        [--bpm N] [--nudge=-1,0] [--keep-countin]

--nudge: one whole-beat offset per take to fix which beat is "the 1" (a vocal
that comes in a beat late -> --nudge=-1,0). Use '=' so the leading - parses.
--keep-countin: leave the "1-2-3-4" in (aligned at count 1) to check by ear.
"""
import argparse
import os

import soundfile as sf

from jamyourself import engine as we
from jamyourself.pipeline import make_audio_jam


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir")
    ap.add_argument("takes", nargs="+")
    ap.add_argument("--bpm", type=float, default=None)
    ap.add_argument("--nudge", default=None,
                    help="whole-beat offset per take to fix which beat is the 1, "
                         "e.g. --nudge=-1,0 (use '=' so leading - parses)")
    ap.add_argument("--keep-countin", action="store_true",
                    help="keep the '1-2-3-4' audible (align at count 1)")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    nudges = None
    if args.nudge:
        nudges = [int(x) for x in args.nudge.replace(" ", "").split(",")]
        if len(nudges) != len(args.takes):
            ap.error("--nudge must have one value per take")

    straight, info = make_audio_jam(args.takes, target_bpm=args.bpm,
                                    nudges=nudges,
                                    keep_countin=args.keep_countin)
    out = os.path.join(args.outdir, "mix.wav")
    sf.write(out, straight, we.SR)
    print(f"\n✓ {out}   (target {info['target_bpm']:.1f} bpm"
          + (", count-in kept" if info['keep_countin'] else "") + ")")
    print("  tweak alignment with --nudge=<beats-per-take>, e.g. --nudge=-1,0")


if __name__ == "__main__":
    main()
