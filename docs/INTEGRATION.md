# Embedding jam-yourself into ki-mathias.de (QuantenBlog)

The web app is already styled to the blog's design language (Inter, `gray-950`
canvas, cyan/amber accents, `cyan→blue→amber` gradient title, `rounded-2xl`
cards). Its CSS is **self-contained** (own CSS variables, no Tailwind classes),
so it won't collide with the blog's purged `vendor/tailwind.css`.

## How the blog mounts components (today)

```html
<div class="component-wrap"><div id="mount-jam-yourself"></div></div>
```
and in the page's lazy-mount glue:
```js
var COMPONENTS = { 'mount-jam-yourself': window.JamYourself, /* … */ };
// ReactDOM.createRoot(el).render(React.createElement(Comp));
```

## What's needed to drop it in (one small refactor)

The blog's components are React + classic `<script>` globals; jam-yourself is
ES-module + vanilla DOM. Bridge it like this:

1. **Self-contained mount.** Refactor `js/app.js` to export `mountApp(rootEl)`
   that builds its own DOM into `rootEl` (instead of relying on the static
   `index.html` ids). `index.html` then just calls
   `mountApp(document.querySelector('#app'))`.

2. **Expose a React wrapper** (`jamyourself-components.js`, classic script,
   like the other `*-components.js`):
   ```js
   function JamYourself() {
     const ref = React.useRef(null);
     React.useEffect(() => { window.__jamMount && window.__jamMount(ref.current); }, []);
     return React.createElement('div', { ref });
   }
   window.JamYourself = JamYourself;
   ```

3. **Load the engine as a module** that sets `window.__jamMount = mountApp`:
   ```html
   <script type="module">
     import { mountApp } from '/jam/js/app.js';
     window.__jamMount = mountApp;
   </script>
   ```

4. Add `'mount-jam-yourself': window.JamYourself` to that page's `COMPONENTS`
   map, copy `docs/` to e.g. `/jam/` in the blog, and link `css/style.css`.

That's it — the IntersectionObserver lazy-mounts it like every other widget,
and audio still runs fully client-side.

## Local testing (standalone)

```bash
cd docs && python3 -m http.server 8090   # 8000 is the blog dev server
# open http://localhost:8090
```
