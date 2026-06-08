"""Click-less tempo-warp engine.

Align a 'follower' instrument take onto a 'master' take's timeline without a
metronome / click track. The player counts in percussively ("1-2-3-4" with
claps or sticks) so every take shares a detectable start anchor; tempo drift
between independently recorded takes is then removed computationally.

Pipeline:
  1. onset-strength envelope per stem (optionally band-passed per instrument)
  2. rigid global offset via FFT cross-correlation (removes the bulk start
     difference between takes)
  3. DTW on the onset envelopes (removes the residual tempo drift)
  4. a monotone, *smoothed* warp curve fitted to the DTW path -- monotone so
     time never runs backwards, smoothed so DTW-path noise is not baked into
     the time axis as audible jitter
  5. pitch-preserving, time-varying stretch via rubberband (pyrubberband)

Only followers are warped; the master stem is left untouched.
"""
import subprocess

import numpy as np
import librosa
import pyrubberband as pyrb
from scipy import signal
from scipy.interpolate import PchipInterpolator

SR = 22050
HOP = 256                       # onset-env hop -> ~11.6 ms time resolution
ENV_FPS = SR / HOP


# ---------------------------------------------------------------- io / features
def load_mono(path, sr=SR):
    """Decode any media file to mono float32 at `sr` via ffmpeg."""
    cmd = ["ffmpeg", "-i", path, "-vn", "-ac", "1", "-ar", str(sr),
           "-f", "f32le", "-loglevel", "error", "pipe:1"]
    r = subprocess.run(cmd, capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32).copy()


def bandpass(x, lo, hi, sr=SR, order=4):
    sos = signal.butter(order, [lo, hi], btype="band", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, x).astype(np.float32)


def _norm(x):
    return (x - x.mean()) / (x.std() + 1e-9)


def onset_env(y, band=None, sr=SR, hop=HOP):
    """Onset-strength envelope; band = (lo, hi) Hz restricts to one instrument."""
    if band is not None:
        y = bandpass(y, band[0], band[1], sr)
    return librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)


# ---------------------------------------------------------------- alignment
def global_offset(ref, sig, sr=SR):
    """Rigid lag (seconds) such that ref-time t ~ sig-time (t - offset)."""
    c = signal.fftconvolve(_norm(ref), _norm(sig)[::-1], mode="full")
    k = int(np.argmax(np.abs(c)))
    return (k - (len(sig) - 1)) / sr


def dtw_correspondence(env_ref, env_fol, hop=HOP, sr=SR, band_s=2.0):
    """DTW between two onset envelopes that are ALREADY roughly aligned.

    Returns (t_fol, t_ref): matched time points (seconds) on each timeline.
    band_s is an ABSOLUTE Sakoe-Chiba radius in seconds: DTW may deviate from
    the diagonal by at most band_s. This must be small (the rigid offset has
    already removed the bulk), otherwise on repetitive music DTW skips whole
    bars (octave/phase ambiguity) and produces a non-monotone, wrong warp."""
    R = _norm(env_ref)[np.newaxis, :]
    F = _norm(env_fol)[np.newaxis, :]
    band_rad = max(1, int(band_s * sr / hop))
    _, wp = librosa.sequence.dtw(
        X=R, Y=F, metric="euclidean",
        global_constraints=True, band_rad=band_rad,
    )
    wp = wp[::-1]                       # forward order; cols = [ref_idx, fol_idx]
    t_ref = wp[:, 0] * hop / sr
    t_fol = wp[:, 1] * hop / sr
    return t_fol, t_ref


def fit_warp_curve(t_fol, t_ref, bin_s=0.5):
    """Monotone, *smoothed* f: follower_time -> master_time.

    The raw DTW path is a noisy staircase; interpolating exactly through every
    point would inject that noise into the time axis (audible jitter). So we
    DENOISE first: bin the path along follower-time into bin_s windows, take the
    median ref-time per bin (robust to DTW outliers), enforce monotonicity, then
    PCHIP through the coarse anchors -> smooth, monotone, no time reversal.
    bin_s trades smoothness (larger) vs. drift-tracking (smaller)."""
    order = np.argsort(t_fol, kind="stable")
    tf, tr = t_fol[order], t_ref[order]
    edges = np.arange(tf[0], tf[-1] + bin_s, bin_s)
    idx = np.clip(np.searchsorted(edges, tf) - 1, 0, len(edges) - 2)
    anchors_f, anchors_r = [], []
    for b in range(len(edges) - 1):
        sel = idx == b
        if sel.any():
            anchors_f.append(np.median(tf[sel]))
            anchors_r.append(np.median(tr[sel]))
    anchors_f = np.asarray(anchors_f)
    anchors_r = np.maximum.accumulate(np.asarray(anchors_r))  # monotone
    keep = np.concatenate([[True], np.diff(anchors_f) > 1e-9])
    return PchipInterpolator(anchors_f[keep], anchors_r[keep], extrapolate=True)


# ---------------------------------------------------------------- warp exec
def warp_audio(y_fol, warp_fn, sr=SR, anchors_per_s=50):
    """Apply f (follower_time -> master_time) to audio, pitch-preserving.

    rubberband requires a time-map that is non-negative, strictly increasing in
    both columns, and whose first/last entries are the first/last input sample."""
    n = len(y_fol)
    dur = n / sr
    t_in = np.linspace(0.0, dur, int(dur * anchors_per_s) + 2)
    # PCHIP may extrapolate below 0 at the edges; clamp then re-monotonise
    t_out = np.maximum.accumulate(np.clip(warp_fn(t_in), 0.0, None))
    src = np.round(t_in * sr).astype(np.int64)
    tgt = np.round(t_out * sr).astype(np.int64)
    src[0], tgt[0], src[-1] = 0, max(0, int(tgt[0])), n
    pairs = [(int(src[0]), int(tgt[0]))]
    for a, b in zip(src[1:], tgt[1:]):
        if a > pairs[-1][0] and b > pairs[-1][1]:
            pairs.append((int(a), int(b)))
    if pairs[-1][0] != n:                       # guarantee final = last sample
        pairs.append((n, max(pairs[-1][1] + 1, int(tgt[-1]))))
    y_out = pyrb.timemap_stretch(y_fol.astype(np.float64), sr, pairs)
    return y_out.astype(np.float32)


# ---------------------------------------------------------------- end-to-end
def align_follower(master_y, follower_y, band=None, sr=SR, bin_s=0.5,
                   band_s=2.0, verbose=False):
    """Full chain: warp follower onto the master timeline.

    Step 1 removes the rigid offset (FFT xcorr) by zero-padding the lagging
    envelope so both are roughly diagonal-aligned; step 2 runs a *tight-band*
    DTW to pick up only the residual drift; the offset is then folded back into
    the warp curve so it maps original-follower-time -> master-time.

    Returns (warped_follower, diagnostics)."""
    env_m = onset_env(master_y, band, sr)
    env_f = onset_env(follower_y, band, sr)

    m_bp = bandpass(master_y, *band, sr) if band else master_y
    f_bp = bandpass(follower_y, *band, sr) if band else follower_y
    off = global_offset(m_bp, f_bp, sr)        # master t ~ follower (t - off)
    if verbose:
        print(f"  rigid offset = {off:+.3f}s")

    # pre-align envelopes: pad the front of whichever lags, in env frames
    shift = int(round(off * sr / HOP))
    pad_f = max(0, shift)
    pad_m = max(0, -shift)
    env_f_a = np.concatenate([np.zeros(pad_f), env_f])
    env_m_a = np.concatenate([np.zeros(pad_m), env_m])

    t_fol_a, t_ref_a = dtw_correspondence(env_m_a, env_f_a, band_s=band_s)
    # undo the padding to return to each signal's own clock
    t_fol = t_fol_a - pad_f * HOP / sr
    t_ref = t_ref_a - pad_m * HOP / sr
    valid = t_fol >= 0
    t_fol, t_ref = t_fol[valid], t_ref[valid]

    warp_fn = fit_warp_curve(t_fol, t_ref, bin_s=bin_s)
    y_warped = warp_audio(follower_y, warp_fn, sr)
    return y_warped, {"offset": off, "t_fol": t_fol, "t_ref": t_ref,
                      "warp_fn": warp_fn}


# ---------------------------------------------------------------- evaluation
def residual_lag_curve(ref, sig, band=None, sr=SR, win=4.0, hop=2.0,
                       search=0.12, min_conf=3.0):
    """Local lag(t) in ms of sig vs ref (residual after alignment, ~0 if good).

    `search` must stay BELOW the musical note spacing, else the windowed xcorr
    locks onto a neighbouring beat (period aliasing) and reports phantom lag.
    `min_conf` rejects ambiguous windows (peak / mean-abs below threshold)."""
    if band:
        ref, sig = bandpass(ref, *band, sr), bandpass(sig, *band, sr)
    wn, hn, sn = int(win * sr), int(hop * sr), int(search * sr)
    ts, lags = [], []
    for s in range(sn, min(len(ref), len(sig)) - wn - sn, hn):
        a = ref[s:s + wn]
        b = sig[s - sn:s + wn + sn]
        if a.std() < 1e-3 or b.std() < 1e-3:
            continue
        c = np.abs(signal.correlate(_norm(a), _norm(b), mode="valid"))
        peak = int(np.argmax(c))
        if c[peak] / (np.mean(c) + 1e-9) < min_conf:
            continue
        frac = 0.0
        if 0 < peak < len(c) - 1:
            d = c[peak - 1] - 2 * c[peak] + c[peak + 1]
            if abs(d) > 1e-12:
                frac = 0.5 * (c[peak - 1] - c[peak + 1]) / d
        lags.append((peak + frac - sn) / sr * 1000)
        ts.append((s + wn / 2) / sr)
    return np.array(ts), np.array(lags)
