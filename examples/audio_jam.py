"""Count-in-anchored audio mix of several separately recorded takes.

Each take is counted in percussively ("1-2-3-4"); we detect each take's downbeat
independently, trim every take to its own downbeat so they all start at musical
t=0, then mix. No metronome, no master mix needed -- the count-in is the anchor.

For comparison we also write a naive mix (raw, from file start) so you can hear
what the count-in anchoring buys.

Usage:
    python examples/audio_jam.py OUT_DIR  TAKE1.mp3  TAKE2.mp3  [...]
"""
import os
import sys

import numpy as np
import soundfile as sf

from jamyourself import countin as ci
from jamyourself import engine as we


def _mix(signals, target_rms=0.12):
    """RMS-match each stem to a common loudness, then sum and peak-limit."""
    leveled = []
    for s in signals:
        r = float(np.sqrt((s ** 2).mean())) + 1e-9
        leveled.append(s * (target_rms / r))
    n = min(len(s) for s in leveled)
    m = np.sum([s[:n] for s in leveled], axis=0)
    peak = float(np.abs(m).max()) + 1e-9
    if peak > 0.97:
        m *= 0.97 / peak
    return m.astype(np.float32)


def main():
    outdir, paths = sys.argv[1], sys.argv[2:]
    os.makedirs(outdir, exist_ok=True)

    raw, trimmed = [], []
    for p in paths:
        y = we.load_mono(p)
        raw.append(y)
        r = ci.detect_countin(y)
        print(f"{os.path.basename(p):28s} downbeat={r['downbeat']:.3f}s  "
              f"bpm={r['bpm']:.1f}  conf={r['confidence']:.2f}")
        trimmed.append(ci.trim_to_downbeat(y, r["downbeat"]))

    naive = os.path.join(outdir, "mix_naive.wav")
    anchored = os.path.join(outdir, "mix_countin.wav")
    sf.write(naive, _mix(raw), we.SR)
    sf.write(anchored, _mix(trimmed), we.SR)
    print(f"\n✓ {naive}      (raw, from file start)")
    print(f"✓ {anchored}   (count-in anchored -- the takes locked together)")


if __name__ == "__main__":
    main()
