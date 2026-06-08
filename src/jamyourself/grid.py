"""Straighten a take onto a steady beat grid.

Count-in anchoring lines up where two takes *start*, but each take still wobbles
in tempo, so they drift apart over time. Cross-instrument DTW can't fix this
(drums and bass play different rhythms -- their onset envelopes share only the
beat). What they DO share is the beat itself, so we beat-track each take and
warp it so its beats land on a steady grid at a common target tempo. Every take
straightened to the same tempo stays locked for the whole song.
"""
import numpy as np
import librosa
from scipy.interpolate import PchipInterpolator

from .engine import SR, HOP, warp_audio


def track_beats(y, sr=SR, hop=HOP, start_bpm=120.0):
    """Beat times (seconds) for a take that starts on its downbeat."""
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beats = librosa.beat.beat_track(
        onset_envelope=env, sr=sr, hop_length=hop, units="time",
        start_bpm=start_bpm, tightness=100)
    beats = np.asarray(beats, dtype=float)
    if len(beats) and beats[0] > 0.25:        # ensure a beat at the downbeat
        beats = np.insert(beats, 0, 0.0)
    beats = np.maximum.accumulate(beats)
    # drop near-duplicate beats (PchipInterpolator needs strictly increasing x)
    keep = np.concatenate([[True], np.diff(beats) > 1e-3])
    return float(np.atleast_1d(tempo)[0]), beats[keep]


def straighten_to_grid(y, target_period, sr=SR, start_bpm=120.0):
    """Warp `y` (must start on the downbeat) so its tracked beats sit on a steady
    grid of `target_period` seconds -> constant tempo. Returns (warped, diag)."""
    tempo, beats = track_beats(y, sr=sr, start_bpm=start_bpm)
    if len(beats) < 2:
        return y, {"tempo": tempo, "n_beats": len(beats), "warped": False}
    grid = np.arange(len(beats)) * target_period
    warp_fn = PchipInterpolator(beats, grid, extrapolate=True)
    return warp_audio(y, warp_fn, sr=sr), {
        "tempo": tempo, "n_beats": len(beats), "beats": beats, "warped": True}
