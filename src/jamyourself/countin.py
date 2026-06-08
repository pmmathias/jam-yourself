"""Percussive count-in detection.

The player counts in "1-2-3-4" percussively (claps / sticks) before every take.
Those four evenly spaced onsets give us, per take and *independently* of any
other take:
  * a hard start anchor  -> the downbeat (beat 1 of the first real bar)
  * an initial tempo      -> from the spacing of the four counts

This is the robust alternative to a cross-layer rigid offset: two different
instruments (drums vs. bass) share little spectral content, so cross-correlating
them is weak; but each take carries its own count-in, so each can be anchored to
its own musical t=0. Trim every take to its downbeat and they all start aligned.
"""
import numpy as np
import librosa

from .engine import SR, HOP, load_mono  # noqa: F401  (load_mono re-exported)

# plausible beat period for the count-in: 50..240 bpm
_MIN_IOI = 0.25
_MAX_IOI = 1.20


def detect_countin(y, sr=SR, hop=HOP, search_s=12.0, max_cov=0.12, n_counts=4):
    """Find the count-in at the start of `y`.

    Scans onsets in the first `search_s` seconds for the earliest run of
    `n_counts` onsets whose inter-onset intervals are nearly equal (coefficient
    of variation <= max_cov) and in a plausible tempo range.

    Returns dict: downbeat (s), bpm, beat_period (s), counts (onset times),
    confidence (1 - cov). Raises ValueError if no count-in is found.
    """
    env = librosa.onset.onset_strength(y=y[: int(search_s * sr)], sr=sr,
                                       hop_length=hop)
    onsets = librosa.onset.onset_detect(
        onset_envelope=env, sr=sr, hop_length=hop, units="time",
        backtrack=True,
    )
    if len(onsets) < n_counts:
        raise ValueError(f"only {len(onsets)} onsets found; need {n_counts}")

    best = None
    for i in range(len(onsets) - n_counts + 1):
        run = onsets[i:i + n_counts]
        iois = np.diff(run)
        mean_ioi = float(iois.mean())
        if not (_MIN_IOI <= mean_ioi <= _MAX_IOI):
            continue
        cov = float(iois.std() / (mean_ioi + 1e-9))
        if cov > max_cov:
            continue
        if best is None or run[0] < best["counts"][0]:   # earliest qualifying
            best = {
                "counts": run,
                "beat_period": mean_ioi,
                "bpm": 60.0 / mean_ioi,
                "downbeat": float(run[-1] + mean_ioi),    # "1" after "...4"
                "confidence": 1.0 - cov,
            }
    if best is None:
        raise ValueError("no evenly-spaced count-in found")
    return best


def trim_to_downbeat(y, downbeat, sr=SR):
    """Drop everything before the downbeat so the take starts at musical t=0."""
    i = max(0, int(round(downbeat * sr)))
    return y[i:]
