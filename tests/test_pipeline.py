"""Unit tests for pipeline helpers (no audio I/O)."""
import numpy as np

from jamyourself import engine as we
from jamyourself.pipeline import _nudge, mix_stems


def test_nudge_shifts_by_whole_beats():
    period = 0.5
    n = int(round(period * we.SR))
    y = np.ones(5 * n, dtype=np.float32)

    assert len(_nudge(y, 0, period)) == len(y)
    later = _nudge(y, 1, period)            # +1 beat -> padded front
    assert len(later) == len(y) + n and np.all(later[:n] == 0)
    earlier = _nudge(y, -1, period)         # -1 beat -> trimmed front
    assert len(earlier) == len(y) - n


def test_mix_levels_quiet_and_loud_equally():
    sr = we.SR
    quiet = 0.05 * np.sin(2 * np.pi * 110 * np.arange(sr) / sr).astype(np.float32)
    loud = 0.8 * np.sin(2 * np.pi * 220 * np.arange(sr) / sr).astype(np.float32)
    m = mix_stems([quiet, loud])
    assert np.abs(m).max() <= 0.98          # peak-limited, no clipping
