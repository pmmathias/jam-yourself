"""Count-in detection on a synthetic '1-2-3-4' + music signal."""
import numpy as np
import pytest

from jamyourself import countin as ci
from jamyourself.engine import SR


def _click(sr=SR, dur=0.04):
    n = int(dur * sr)
    return (np.exp(-np.linspace(0, 20, n)) *
            np.random.default_rng(1).standard_normal(n)).astype(np.float32)


def make_take(bpm=120, lead_s=0.7, sr=SR, dur=20.0, seed=0):
    """Four percussive counts at `bpm`, then a busier music pattern."""
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    n = int(dur * sr)
    y = np.zeros(n, dtype=np.float32)
    clk = _click(sr)
    # the four counts
    count_times = [lead_s + k * beat for k in range(4)]
    for t in count_times:
        i = int(t * sr)
        y[i:i + len(clk)] += clk
    # music starts on the downbeat = lead_s + 4*beat, denser & varied
    downbeat = lead_s + 4 * beat
    t = downbeat
    while t < dur - 0.2:
        i = int(t * sr)
        L = int(0.1 * sr)
        env = np.exp(-np.linspace(0, 8, L))
        tone = rng.uniform(0.3, 1.0) * env * np.sin(
            2 * np.pi * rng.choice([110, 165, 220]) * np.arange(L) / sr)
        y[i:i + L] += tone.astype(np.float32)
        t += beat * rng.choice([0.5, 1.0])
    return y / (np.abs(y).max() + 1e-9), downbeat, bpm


@pytest.mark.parametrize("bpm", [100, 120, 144])
def test_detects_downbeat_and_tempo(bpm):
    y, true_db, true_bpm = make_take(bpm=bpm)
    r = ci.detect_countin(y)
    assert abs(r["downbeat"] - true_db) < 0.06, \
        f"downbeat {r['downbeat']:.3f} vs {true_db:.3f}"
    assert abs(r["bpm"] - true_bpm) < 4.0, f"bpm {r['bpm']:.1f} vs {true_bpm}"


def test_countin_with_noise_between_counts():
    """Real takes have stray onsets between the counts (string/finger noise) and
    a strong every-other-beat pulse that tempts a half-tempo lock. The detector
    must still recover the true tempo and downbeat."""
    bpm, lead = 120, 0.6
    y, true_db, _ = make_take(bpm=bpm, lead_s=lead, seed=3)
    beat = 60.0 / bpm
    sr = SR
    clk = _click(sr, dur=0.03)
    rng = np.random.default_rng(7)
    # inject weaker stray onsets at random offsets within the count-in region
    for k in range(4):
        t = lead + k * beat + rng.uniform(0.12, 0.3)
        i = int(t * sr)
        y[i:i + len(clk)] += 0.5 * clk
    y = y / (np.abs(y).max() + 1e-9)

    r = ci.detect_countin(y)
    assert abs(r["bpm"] - bpm) < 6.0, f"bpm {r['bpm']:.1f} (half/double-tempo?)"
    assert abs(r["downbeat"] - true_db) < 0.07, \
        f"downbeat {r['downbeat']:.3f} vs {true_db:.3f}"


def test_trim_to_downbeat():
    y, true_db, _ = make_take(bpm=120)
    trimmed = ci.trim_to_downbeat(y, true_db)
    assert len(trimmed) == len(y) - int(round(true_db * SR))
