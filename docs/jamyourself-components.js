/* jam-yourself — React wrapper for embedding into ki-mathias.de (QuantenBlog).
 *
 * Classic <script> (like the blog's other *-components.js). It exposes
 * window.JamYourself, which the blog's lazy-mount glue renders into a
 * <div id="mount-jam-yourself"></div>:
 *
 *   var COMPONENTS = { 'mount-jam-yourself': window.JamYourself, ... };
 *   ReactDOM.createRoot(el).render(React.createElement(Comp));
 *
 * The actual app is the ES-module engine; load it once and hand the mount fn to
 * this wrapper before the component mounts:
 *
 *   <script type="module">
 *     import { mountApp } from "/jam/js/app.js";
 *     window.__jamMount = mountApp;
 *     window.__jamCss   = "/jam/css/style.css";  // optional: wrapper injects it
 *   </script>
 *   <script src="/jam/jamyourself-components.js"></script>
 */
(function () {
  "use strict";
  function JamYourself() {
    var ref = React.useRef(null);
    React.useEffect(function () {
      if (!window.__jamMount || !ref.current) {
        ref.current && (ref.current.textContent = "jam-yourself engine not loaded");
        return;
      }
      var destroy = window.__jamMount(ref.current, { cssHref: window.__jamCss });
      return function () { if (typeof destroy === "function") destroy(); };
    }, []);
    return React.createElement("div", { ref: ref });
  }
  window.JamYourself = JamYourself;
})();
