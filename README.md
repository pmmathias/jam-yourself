# jam-yourself

**Lay your good studio audio under your phone videos — even though every take
drifts in tempo and none of them used a click track.**

`jam-yourself` is for one-man-band songwriters and YouTubers who record each
instrument separately (drums, then bass, then guitar…) into GarageBand while
filming themselves on a phone — and then want a single video where you see
yourself playing *n* instruments side by side, but hear the clean,
GarageBand-recorded tracks.

The hard part: you don't play to a metronome, so the takes drift relative to
each other, and each phone clip starts at a different moment. `jam-yourself`
removes that drift computationally so the layers lock together.

> Status: **early prototype.** The core tempo-warp engine is validated on
> ground-truth data (see *Validation* below). The full video pipeline and the
> count-in front-end are still to come — see *Roadmap*.

## How it works

You count yourself in **percussively** ("1-2-3-4" with claps or sticks) so every
take — even a vocal or guitar take — has a sharp, detectable start. Then, per
follower take:

1. **Onset-strength envelope** per stem (optionally band-passed to the
   instrument's frequency range, e.g. bass 40–300 Hz, drums 150–6000 Hz).
2. **Rigid offset** via FFT cross-correlation — removes the bulk start
   difference between two takes.
3. **DTW** (dynamic time warping) on the onset envelopes — removes the residual
   *tempo drift*. DTW is used instead of independent beat-counting because the
   stems are different layers of the same song and share their beat pulse, not
   their spectral content; DTW also tolerates missing/extra onsets, so it
   doesn't need the two takes to have the same number of detected beats.
4. **Monotone, smoothed warp curve** (PCHIP through a denoised, binned DTW
   path). Monotone so time never runs backwards; *smoothed* because
   interpolating exactly through the noisy DTW path would bake jitter into the
   time axis (interpolation vs. approximation — smoothing wins here).
5. **Pitch-preserving, time-varying stretch** via
   [Rubber Band](https://breakfastquay.com/rubberband/) (`pyrubberband`).

One take is chosen as the rhythmic **master** (default: drums — the most
reliable beat grid) and is left untouched; all other takes are warped onto it.

## Validation

`tests/test_synthetic.py` builds an onset-rich signal, applies a **known** smooth
tempo drift (±150 ms, 20 s period), and checks the engine recovers it. Isolated
component accuracy measured during development:

| stage | error |
|---|---|
| DTW path vs. ground truth | ~3 ms |
| Rubber Band time-map fidelity | ~4 ms |
| full chain (drift removed) | ≥ ~60 % of injected drift |

## Install

Requires the **Rubber Band CLI** and **ffmpeg** as system dependencies:

```bash
brew install rubberband ffmpeg        # macOS
# sudo apt install rubberband-cli ffmpeg   # Debian/Ubuntu
```

Then a Python virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -e .            # optional: install the package itself
```

## Usage

Full pipeline — tile several takes under a master mix:

```bash
jam-yourself --master mix.mp3 --out jam.mp4 \
    --take drums.mp4:150:6000 \
    --take bass.mp4:40:300
```

Each `--take` is `VIDEO[:LO:HI]`, where `LO:HI` is the instrument's frequency
band in Hz (optional but strongly recommended for clean alignment).

Just align one pair (audio only):

```bash
python examples/align_pair.py drums.mp4 bass.mp4 --band 40 300 --out bass_aligned.wav
```

```python
from jamyourself import engine
master = engine.load_mono("drums.mp4")
bass   = engine.load_mono("bass.mp4")
aligned, diag = engine.align_follower(master, bass, band=(40, 300))
```

### See the warp work

`examples/drift_demo.py` takes a clean bass take, applies a known tempo drift to
its picture *and* sound, then re-locks it — and renders a 3-up you can watch
(`clean | drifted (slips) | corrected (locked)`):

```bash
python examples/drift_demo.py bass.mp4 ./out
# -> ./out/jam_drift_demo.mp4   (drift 159ms -> 25ms, 85% removed)
```

Run the tests:

```bash
pytest
```

## Status & known limits

- **Tempo-warp engine: solid.** Removes ~85–90% of injected drift on real and
  synthetic stems; warp curve is monotone; video stays locked to audio.
- **Cross-instrument auto-alignment relies on a count-in.** Aligning a bass take
  directly against a full master mix (different spectral content) via rigid
  cross-correlation is fragile — a heavily drifted take can get a wrong global
  offset. The fix is the percussive count-in (each take anchored to its own
  musical t=0); detection is built but **not yet wired into the pipeline**, and
  needs real count-in material to validate.
- Tight takes (little real drift) render fine but show no visible warp — expected.

## Roadmap

- [x] Tempo-warp engine (onset → DTW → monotone smooth curve → Rubber Band)
- [x] Ground-truth validation harness
- [x] Percussive count-in detection (start anchor + initial tempo)
- [x] Apply the same warp curve to **video** (ffmpeg setpts polynomial)
- [x] Side-by-side tiled video render (audio = master mix)
- [x] End-to-end CLI
- [ ] Wire count-in into the pipeline + robust cross-content offset fallback
- [ ] Multi-track session model + auto master selection
- [ ] Per-instrument onset detectors (drums → bass → guitar/keys)

## License

MIT
