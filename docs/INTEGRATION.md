# Embedding jam-yourself into ki-mathias.de (QuantenBlog)

Done & validated in a real browser — see **`embed-example.html`** for a working
copy-paste reference that mounts the widget exactly like the blog's other React
components (vendored React + IntersectionObserver lazy-mount).

The app is **embed-ready**:
- `mountApp(rootEl, {cssHref})` (in `js/app.js`) builds its whole DOM inside
  `rootEl` — no dependence on page-level ids.
- All styles are **scoped under `.jy`** (`css/style.css`), so they never touch
  the host page's `body` / `h1` / `button` (verified: the blog's own headings
  stay unaffected). The component sets no page background — it sits on the blog's.
- `jamyourself-components.js` exposes `window.JamYourself`, the React wrapper.

## Drop it into a blog page (4 lines + a mount div)

```html
<!-- once, in <head> or before </body> -->
<link rel="stylesheet" href="/jam/css/style.css">
<script type="module">
  import { mountApp } from "/jam/js/app.js";
  window.__jamMount = mountApp;       // hand the engine to the React wrapper
  window.__jamCss   = "/jam/css/style.css";
</script>
<script src="/jam/jamyourself-components.js"></script>

<!-- where the widget should appear -->
<div class="component-wrap"><div id="mount-jam-yourself"></div></div>
```

Then add it to that page's existing lazy-mount map:

```js
var COMPONENTS = {
  /* … existing … */
  'mount-jam-yourself': window.JamYourself,
};
```

Copy the `docs/` folder to `/jam/` in the blog repo (it's all static). React/
ReactDOM are already on the page; jam-yourself ships its own vendored copies only
for the standalone `embed-example.html`.

## Local testing (standalone)

```bash
cd docs && python3 -m http.server 8090     # 8000 is the blog dev server
# http://localhost:8090            — standalone app
# http://localhost:8090/embed-example.html — blog-style embed demo
node tests/run.mjs                          # 26 DSP tests (Node)
```
