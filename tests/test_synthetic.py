"""Ground-truth validation on a synthetic, onset-rich signal (no private audio).

We build a pluck pattern with musical structure (varied dynamics, sharp
transients, occasional rests -> a distinctive onset envelope DTW can lock onto),
apply a KNOWN smooth tempo drift to a copy, then let the engine recover it and
assert the residual misalignment is cut well below the injected drift.
"""
import numpy as np
import pyrubberband as pyrb
import pytest

from jamyourself import engine as we

SR = we.SR


def make_signal(dur=60.0, bpm=120, sr=SR, seed=0):
    """Onset-rich mono signal: decaying plucks with dynamics + transients."""
    rng = np.random.default_rng(seed)
    n = int(dur * sr)
    y = np.zeros(n, dtype=np.float32)
    beat = 60.0 / bpm
    t = 0.0
    while t < dur - 0.2:
        if rng.random() < 0.12:                 # occasional rest
            t += beat * 0.5
            continue
        i = int(t * sr)
        length = int(0.12 * sr)
        env = np.exp(-np.linspace(0, 8, length))
        amp = rng.uniform(0.3, 1.0)             # dynamics
        freq = rng.choice([110, 147, 165, 220])
        tone = amp * env * np.sin(2 * np.pi * freq * np.arange(length) / sr)
        hit = tone.astype(np.float32)
        click = (rng.standard_normal(int(0.005 * sr)) * 0.5).astype(np.float32)
        hit[:len(click)] += click               # sharp onset transient
        y[i:i + length] += hit
        t += beat * rng.choice([0.5, 1.0], p=[0.4, 0.6])
    return y / (np.abs(y).max() + 1e-9)


def _timemap(y, t_in, t_out, sr=SR):
    t_out = np.maximum.accumulate(t_out)
    tm = [(int(round(a * sr)), int(round(b * sr))) for a, b in zip(t_in, t_out)]
    clean = [tm[0]]
    for a, b in tm[1:]:
        if a > clean[-1][0] and b > clean[-1][1]:
            clean.append((a, b))
    if clean[-1][0] != len(y):                  # rubberband wants last sample
        clean.append((len(y), clean[-1][1] + int(0.2 * sr)))
    return pyrb.timemap_stretch(y.astype(np.float64), sr, clean).astype(np.float32)


def inject_drift(y, amp=0.15, period=20.0, sr=SR):
    dur = len(y) / sr
    t_in = np.linspace(0, dur, int(dur * 50) + 2)
    t_out = t_in + amp * np.sin(2 * np.pi * t_in / period)
    return _timemap(y, t_in, t_out - t_out[0], sr)


def _rms(x):
    return float(np.sqrt((x ** 2).mean())) if len(x) else float("nan")


@pytest.mark.parametrize("seed", [0, 1, 2])
def test_engine_removes_known_drift(seed):
    master = make_signal(seed=seed)
    drifted = inject_drift(master)

    _, lag_before = we.residual_lag_curve(master, drifted, search=0.25, min_conf=2.0)
    rms_before = _rms(lag_before)

    recovered, _ = we.align_follower(master, drifted, band=None, bin_s=0.4)
    _, lag_after = we.residual_lag_curve(master, recovered, search=0.25, min_conf=2.0)
    rms_after = _rms(lag_after)

    assert rms_before > 60.0, f"test setup weak: {rms_before:.0f}ms"
    # engine removes ~90% in practice; require at least 60% with margin
    assert rms_after < 0.4 * rms_before, f"{rms_before:.0f} -> {rms_after:.0f} ms"


def test_warp_curve_is_monotone():
    master = make_signal(dur=30.0)
    drifted = inject_drift(master)
    _, diag = we.align_follower(master, drifted, band=None, bin_s=0.4)
    g = np.linspace(0, len(drifted) / SR, 500)
    y = diag["warp_fn"](g)
    assert np.all(np.diff(y) >= -1e-6), "warp curve must be non-decreasing"
