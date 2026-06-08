"""Beat-grid straightening: a drifting click train must come out steady."""
import librosa
import numpy as np

from jamyourself import engine as we
from jamyourself import grid

SR = we.SR


def _click(sr=SR, dur=0.03):
    n = int(dur * sr)
    return (np.exp(-np.linspace(0, 18, n)) *
            np.sin(2 * np.pi * 1500 * np.arange(n) / sr)).astype(np.float32)


def make_drifting_clicks(base=0.5, n_beats=20, amp=0.12, sr=SR):
    """Click train whose beat interval wobbles +/-amp around `base` seconds."""
    intervals = base * (1 + amp * np.sin(2 * np.pi * np.arange(n_beats) / 8))
    times = np.concatenate([[0.0], np.cumsum(intervals)])
    y = np.zeros(int((times[-1] + 0.5) * sr), dtype=np.float32)
    clk = _click(sr)
    for t in times:
        i = int(t * sr)
        y[i:i + len(clk)] += clk
    return y / (np.abs(y).max() + 1e-9), intervals


def _onset_intervals(y):
    o = librosa.onset.onset_detect(y=y, sr=SR, hop_length=we.HOP, units="time",
                                   backtrack=True)
    return np.diff(o)


def test_straighten_regularizes_tempo():
    y, intervals = make_drifting_clicks(base=0.5, amp=0.12)
    drift_std = float(np.std(intervals))

    warped, diag = grid.straighten_to_grid(y, target_period=0.5, start_bpm=120)
    assert diag["warped"]

    iv = _onset_intervals(warped)
    # discard first/last (edge effects) and measure regularity
    iv = iv[1:-1]
    assert np.std(iv) < 0.5 * drift_std, \
        f"warped std {np.std(iv)*1000:.0f}ms vs drift {drift_std*1000:.0f}ms"
    assert abs(np.median(iv) - 0.5) < 0.06, f"median {np.median(iv):.3f}s"
