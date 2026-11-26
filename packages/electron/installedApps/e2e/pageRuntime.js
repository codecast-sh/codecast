// The stand-in's live data runtime (e2e/standin.mjs injects it into every
// page it serves, after examples/installed-apps/dev/fake-cast.js): cast.data
// and cast.subscribe read the stand-in's _data route, and a subscription
// polls it twice a second and calls back when the answer changed, the way a
// republished reader or a refresh reaches a page on a.codecast.sh.
(function () {
  var E = window.__E2E;
  if (!E) return;
  var gate = E.gate && E.gate.k ? "?k=" + encodeURIComponent(E.gate.k) : "";
  var url = function (id) { return E.origin + "/" + E.slug + "/_data/" + encodeURIComponent(id) + gate; };
  window.cast = window.cast || {};
  window.cast.data = function (id) { return fetch(url(id), { cache: "no-store" }).then(function (r) { return r.json(); }); };
  window.cast.subscribe = function (id, cb) {
    var last = null;
    var stopped = false;
    (async function tick() {
      while (!stopped) {
        try {
          var text = await (await fetch(url(id), { cache: "no-store" })).text();
          if (text !== last) {
            last = text;
            cb(JSON.parse(text));
          }
        } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 500); });
      }
    })();
    return function () { stopped = true; };
  };
})();
