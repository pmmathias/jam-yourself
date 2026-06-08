"""Lock several separately recorded audio takes into one tight mix -- no click.

Each take is counted in percussively ("1-2-3-4"); jam-yourself detects each
take's downbeat (anchor), then warps each onto a steady common-tempo grid so
they start together AND stay together for the whole take.

Writes three files so you can hear each stage:
    mix_naive.wav         raw, from file start
    mix_countin.wav       count-in anchored (starts together, may drift apart)
    mix_straightened.wav  + beat-grid warp (stays locked)  <- the good one

Usage:
    python examples/audio_jam.py OUT_DIR  TAKE1 TAKE2 [...]  [--bpm N] [--nudge 0,-1]

--nudge is a comma list of whole-beat offsets, one per take, to resolve the
"which beat is the 1" ambiguity (e.g. a vocal that comes in a beat late).
"""
import argparse
import os

import soundfile as sf

from jamyourself import countin as ci
from jamyourself import engine as we
from jamyourself.pipeline import make_audio_jam, mix_stems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("outdir")
    ap.add_argument("takes", nargs="+")
    ap.add_argument("--bpm", type=float, default=None)
    ap.add_argument("--nudge", default=None,
                    help="comma list of whole-beat offsets per take, e.g. 0,-1")
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)

    nudges = None
    if args.nudge:
        nudges = [int(x) for x in args.nudge.split(",")]
        if len(nudges) != len(args.takes):
            ap.error("--nudge must have one value per take")

    raw = [we.load_mono(p) for p in args.takes]
    anchored = [ci.trim_to_downbeat(y, ci.detect_countin(y)["downbeat"])
                for y in raw]
    straight, info = make_audio_jam(args.takes, target_bpm=args.bpm, nudges=nudges)

    sf.write(os.path.join(args.outdir, "mix_naive.wav"), mix_stems(raw), we.SR)
    sf.write(os.path.join(args.outdir, "mix_countin.wav"), mix_stems(anchored), we.SR)
    sf.write(os.path.join(args.outdir, "mix_straightened.wav"), straight, we.SR)
    print(f"\n✓ wrote mix_naive / mix_countin / mix_straightened to {args.outdir}")
    print(f"  target tempo {info['target_bpm']:.1f} bpm")


if __name__ == "__main__":
    main()
