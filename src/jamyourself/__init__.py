"""jamyourself -- align multi-instrument takes without a click track."""
from .countin import detect_countin, trim_to_downbeat
from .grid import straighten_to_grid, track_beats
from .engine import (
    SR,
    align_follower,
    bandpass,
    dtw_correspondence,
    fit_warp_curve,
    global_offset,
    load_mono,
    onset_env,
    residual_lag_curve,
    warp_audio,
)

__version__ = "0.0.1"

__all__ = [
    "SR",
    "align_follower",
    "bandpass",
    "detect_countin",
    "dtw_correspondence",
    "fit_warp_curve",
    "global_offset",
    "load_mono",
    "onset_env",
    "residual_lag_curve",
    "straighten_to_grid",
    "track_beats",
    "trim_to_downbeat",
    "warp_audio",
]
