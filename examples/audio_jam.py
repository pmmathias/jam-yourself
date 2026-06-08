"""Lock several separately recorded audio takes into one tight mix -- no click.

Each take is counted in percussively ("1-2-3-4"); jam-yourself detects each
take's downbeat (anchor), then warps each onto a steady common-tempo grid so
they start together AND stay together for the whole take.

Writes three files so you can hear each stage:
    mix_naive.wav         raw, from file start
    mix_countin.wav       count-in anchored (starts together, may drift apart)
    mix_straightened.wav  + beat-grid warp (stays locked)  <- the good one

Usage:
    python examples/audio_jam.py OUT_DIR  TAKE1  TAKE2  [...]  [--bpm N]
"""
import os
import sys

import soundfile as sf

from jamyourself import countin as ci
from jamyourself import engine as we
from jamyourself.pipeline import make_audio_jam, mix_stems


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    bpm = next((float(sys.argv[i + 1]) for i, a in enumerate(sys.argv)
                if a == "--bpm"), None)
    outdir, paths = args[0], args[1:]
    os.makedirs(outdir, exist_ok=True)

    raw = [we.load_mono(p) for p in paths]
    anchored = [ci.trim_to_downbeat(y, ci.detect_countin(y)["downbeat"])
                for y in raw]
    straight, info = make_audio_jam(paths, target_bpm=bpm)

    sf.write(os.path.join(outdir, "mix_naive.wav"), mix_stems(raw), we.SR)
    sf.write(os.path.join(outdir, "mix_countin.wav"), mix_stems(anchored), we.SR)
    sf.write(os.path.join(outdir, "mix_straightened.wav"), straight, we.SR)
    print(f"\n✓ wrote mix_naive / mix_countin / mix_straightened to {outdir}")
    print(f"  target tempo {info['target_bpm']:.1f} bpm")


if __name__ == "__main__":
    main()
