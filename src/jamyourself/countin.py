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

# plausible beat period for a counted-in "1-2-3-4": ~75..176 bpm. The upper
# bound (0.8s) is deliberately below ~1s so the search cannot lock onto HALF the
# real tempo (a classic failure on a steady count), and the lower bound keeps it
# off double-tempo subdivisions.
_MIN_IOI = 0.34
_MAX_IOI = 0.80


def detect_countin(y, sr=SR, hop=HOP, search_s=8.0, n_counts=4, tol=0.08,
                   t0_window=2.5):
    """Find the percussive count-in at the start of `y`.

    A count-in is the first run of `n_counts` evenly spaced onsets at a sane
    counting tempo, right before the music. We grid-search: for the EARLIEST
    onset that admits a full grid t0 + k*b (every count within `tol` of a real
    onset, b in the counting-tempo range), take it -- a stray onset before the
    count can't form a 4-grid, so it is skipped automatically; capping b below
    ~1s blocks half-tempo locks. Among fits for that t0, prefer the beat period
    whose continued pulse explains the most onsets (coverage), then the tightest.

    Extra onsets between counts (string noise, finger taps) are tolerated.
    Returns dict: downbeat (s), bpm, beat_period (s), counts, confidence.
    Raises ValueError if no count-in is found.
    """
    env = librosa.onset.onset_strength(y=y[: int(search_s * sr)], sr=sr,
                                       hop_length=hop)
    frames = librosa.onset.onset_detect(onset_envelope=env, sr=sr,
                                        hop_length=hop, backtrack=True)
    if len(frames) < n_counts:
        raise ValueError(f"only {len(frames)} onsets found; need {n_counts}")
    times = frames * hop / sr

    def coverage(t0, b):
        grid = np.arange(t0, search_s, b)
        return int(sum(np.min(np.abs(times - g)) <= tol for g in grid))

    best = None
    for t0 in times[times <= t0_window]:
        cands = []
        for b in np.arange(_MIN_IOI, _MAX_IOI + 1e-9, 0.003):
            grid = t0 + b * np.arange(n_counts)
            if grid[-1] > search_s:
                break
            idx, err, ok = [], 0.0, True
            for g in grid:
                d = np.abs(times - g)
                j = int(d.argmin())
                if d[j] > tol:
                    ok = False
                    break
                idx.append(j)
                err += d[j]
            if ok:
                cands.append((coverage(t0, b), -err, b, idx))
        if cands:
            cands.sort(reverse=True)               # max coverage, then min err
            _, _, b, idx = cands[0]
            best = {"idx": idx, "t0": t0, "b": b}
            break                                  # earliest valid t0 wins
    if best is None:
        raise ValueError("no evenly-spaced count-in found")

    matched = times[best["idx"]]
    k = np.arange(n_counts)
    b_fit, a_fit = np.polyfit(k, matched, 1)        # refine period/phase
    resid = float(np.sqrt(np.mean((matched - (a_fit + b_fit * k)) ** 2)))
    return {
        "counts": matched,
        "beat_period": float(b_fit),
        "bpm": 60.0 / float(b_fit),
        "downbeat": float(a_fit + b_fit * n_counts),   # "1" after "...4"
        "confidence": float(max(0.0, 1.0 - resid / (b_fit + 1e-9))),
    }


def trim_to_downbeat(y, downbeat, sr=SR):
    """Drop everything before the downbeat so the take starts at musical t=0."""
    i = max(0, int(round(downbeat * sr)))
    return y[i:]
