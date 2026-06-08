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


def _global_tempo(env, sr, hop):
    try:
        from librosa.feature.rhythm import tempo as _tempo
    except Exception:                               # older librosa
        from librosa.beat import tempo as _tempo
    return float(np.atleast_1d(
        _tempo(onset_envelope=env, sr=sr, hop_length=hop))[0])


def detect_countin(y, sr=SR, hop=HOP, search_s=8.0, n_counts=4, tol=0.08,
                   t0_window=1.6):
    """Find the percussive count-in at the start of `y`.

    The count-in shares the song tempo (you count at the song's speed), so it
    cannot be told from the music by tempo -- only by POSITION: it is the first
    regular pulse. So we:

      1. estimate the global tempo (autocorrelation over the whole take), which
         pins the beat PERIOD and resolves half/double-tempo ambiguity that a
         pure grid search falls for;
      2. for the earliest onset (the first count) find the phase: the beat period
         near the global tempo whose grid t0 + k*b lands an onset within `tol` on
         every one of the n_counts counts; among tempo octaves, prefer the one
         whose continued pulse explains the most onsets (coverage).

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

    b0 = 60.0 / _global_tempo(env, sr, hop)
    # tempo octaves, each searched in a narrow +/-10% band (fine phase/tempo fit)
    centers = [c for c in (b0 / 2, b0, b0 * 2) if _MIN_IOI <= c <= _MAX_IOI]

    def coverage(t0, b):
        grid = np.arange(t0, search_s, b)
        hit = sum(np.min(np.abs(times - g)) <= tol for g in grid)
        return hit

    best = None
    for t0 in times[times <= t0_window]:
        cands = []
        for c in centers:
            for b in np.arange(c * 0.9, c * 1.1, 0.003):
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
            break                                  # earliest t0 wins
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
