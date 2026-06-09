# Integrating the **jam-yourself** widget into ki-mathias.de (QuantenBlog)

Handoff for the agent maintaining the blog. This is a self-contained, static,
client-side widget; embedding it is the same pattern you already use for the
React component visualisations (`*-components.js` mounted via the per-page
`COMPONENTS` map + IntersectionObserver). No build step, no server, no Tailwind
rebuild.

---

## What it is

`jam-yourself` lets a visitor be a one-man band: count in "1-2-3-4", play/record
each instrument separately, and the widget locks the takes to a common tempo and
plays/exports the mix. **Everything runs in the browser** (Web Audio + WebAssembly
SoundTouch); no audio is uploaded.

Source lives in the `jam-yourself` repo under `docs/`. It's already styled to the
blog (Inter, `gray-950` canvas, cyan/amber accents, `cyan→blue→amber` gradient
title, `rounded-2xl` cards).

---

## Step 1 — copy the static files

Copy the widget into the blog repo under **`/jam/`**:

```
cp -R <jam-yourself>/docs/  <blog-repo>/jam/
```

Then **delete the bits the blog already provides / doesn't need**:

```
rm <blog-repo>/jam/vendor/react.production.min.js       # the page already loads React
rm <blog-repo>/jam/vendor/react-dom.production.min.js   # (only used by jam's standalone demo)
rm <blog-repo>/jam/index.html <blog-repo>/jam/embed-example.html  # standalone hosts, not needed
rm -rf <blog-repo>/jam/tests <blog-repo>/jam/package.json <blog-repo>/jam/*.md
```

What must remain under `/jam/`:

```
jam/
  js/            app.js, audio.js, ui.js, recorder.js, ffmpeg.js, videorender.js, dsp/*.js
  vendor/        soundtouch.js                 ← WASM time-stretch (LGPL)
  vendor/ffmpeg/ ffmpeg/ util/ core/           ← ffmpeg.wasm, ~31 MB (the video render)
  css/style.css                                ← scoped under .jy
  fonts/         inter-*.woff2                 ← optional (blog already has Inter)
```

> `vendor/ffmpeg/` (~31 MB, mostly `core/ffmpeg-core.wasm`) powers the in-browser
> tiled-video render and is **lazy-loaded** — fetched only when a visitor clicks
> "Render video", never on page load. It's served same-origin (no CDN, no
> COOP/COEP needed). Keep it if you want the video feature; the audio jam works
> without it. If the repo size matters, host `/jam/vendor/ffmpeg/` on a CDN/LFS
> and adjust the URLs in `js/ffmpeg.js` (they're built from `import.meta.url`).

> The widget's CSS uses **no Tailwind classes** and is fully **scoped under `.jy`**,
> so it can't touch the blog's global `body`/`h1`/`button` styles and you do **not**
> need to regenerate `vendor/tailwind.css`. (Verified: a host page's own headings
> stay unchanged.) The `fonts/` copy is optional — the blog's Inter is fine; if you
> drop it, the widget falls back to the page's Inter via `font-family: 'Inter', …`.

---

## Step 2 — load the engine + wrapper on the page (once)

On the blog page that should host the widget, add these three includes (paths are
**absolute `/jam/...`** so they work from any page URL):

```html
<link rel="stylesheet" href="/jam/css/style.css">

<script type="module">
  import { mountApp } from "/jam/js/app.js";
  window.__jamMount = mountApp;          // hand the ES-module engine to the React wrapper
  window.__jamCss   = "/jam/css/style.css";
</script>

<script src="/jam/jamyourself-components.js"></script>   <!-- defines window.JamYourself -->
```

Requirements (already true on your component pages): **React + ReactDOM are loaded**
on the page (`vendor/react.production.min.js`, `vendor/react-dom.production.min.js`).

---

## Step 3 — place the mount point + register it

Exactly like your other widgets:

```html
<div class="component-wrap"><div id="mount-jam-yourself"></div></div>
```

and add it to that page's existing lazy-mount map (the `COMPONENTS` object in the
page's `DOMContentLoaded` script):

```js
var COMPONENTS = {
  /* … your existing entries … */
  'mount-jam-yourself': window.JamYourself,
};
```

The IntersectionObserver you already have will `ReactDOM.createRoot(el).render(
React.createElement(window.JamYourself))` when it scrolls into view — same as every
other component. Nothing else to wire.

A complete, working reference page is `docs/embed-example.html` in the jam-yourself
repo (it reproduces your lazy-mount glue verbatim).

---

## Notes & gotchas

- **Recording (mic/camera)** needs a secure context — fine on the live HTTPS site
  (`ki-mathias.de`) and on `localhost`; it will silently fail on plain `http://LAN-IP`.
- **Heavy-ish widget** (decodes audio, loads the SoundTouch WASM). Lazy-mounting via
  the IntersectionObserver (which you already do) is exactly right — don't eager-mount.
- **One instance per page** is assumed (it uses a few ids internally, queried only
  within its own root, but keep it to one mount point per page).
- **New blog post?** If it gets its own page, add an entry to `nav.js`'s `POSTS`
  array like the other posts (icon + de/en title/subtitle/href) so the nav updates.
- **Self-contained** — no external network calls, no analytics, no uploads.

## Verify

```bash
cd <blog-repo> && python3 -m http.server 8000
# open the page; the widget should appear inside #mount-jam-yourself,
# and the page's own headings/buttons must look unchanged (CSS is scoped to .jy).
```
