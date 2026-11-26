// Lets the e2e harness run code inside a page whatever renders it: the
// Electron host's BrowserWindow, or the macOS shim's WKWebView, which has no
// DevTools protocol. e2e/standin.mjs injects it into every page it serves.
// On each load it says hello (slug, surface, the version the stand-in served),
// forwards every cast.app host event, and long-polls for code, which it runs
// as the body of an async function and answers with its value or its error
// (with the bridge's .code). It uses only fetch to the stand-in's own address,
// so it works in the opaque origin a browser gets, too.
(function () {
  var E = window.__E2E;
  if (!E) return;
  var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var surface = new URLSearchParams(location.search).get("surface") || "browser";
  var post = function (path, body) {
    return fetch(E.origin + path, { method: "POST", body: JSON.stringify(body), keepalive: true }).catch(function () {});
  };
  var app = window.cast && window.cast.app;
  if (app) {
    ["version", "grants", "surface", "tray-click", "notification-click", "shortcut"].forEach(function (event) {
      app.on(event, function (data) { post("/__e2e/probe/event", { id: id, slug: E.slug, surface: surface, event: event, data: data }); });
    });
  }
  var hello = post("/__e2e/probe/hello", { id: id, slug: E.slug, surface: surface, version: E.version, href: location.href, hasApp: !!app });
  var safe = function (v) {
    try { return v === undefined ? null : JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  };
  (async function loop() {
    await hello;
    for (;;) {
      try {
        var res = await fetch(E.origin + "/__e2e/probe/next?id=" + id, { cache: "no-store" });
        if (res.status === 404) throw new Error("not known yet");
        if (res.status !== 200) continue;
        var cmd = await res.json();
        var out;
        try {
          out = { ok: true, value: safe(await (0, eval)("(async () => {\n" + cmd.code + "\n})()")) };
        } catch (e) {
          out = { ok: false, error: String((e && e.message) || e), code: (e && e.code) || null };
        }
        await post("/__e2e/probe/result", Object.assign({ id: id, n: cmd.n }, out));
      } catch (e) {
        await new Promise(function (r) { setTimeout(r, 500); });
      }
    }
  })();
})();
