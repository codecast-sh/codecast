// The sandbox a codecast mod runs in. The app loads this page into an iframe
// with sandbox="allow-scripts" and no allow-same-origin, so it has an opaque
// origin: no cookies, no storage, no reach into the app. The first message is
// the mod: its code (the SDK bundled with the author's module) and the origins
// its manifest may fetch from. This page locks its own policy to those origins
// before it runs a line of the mod. Contract: packages/shared/contracts/mods.ts.
(function () {
  var loaded = false;
  addEventListener("message", function (ev) {
    if (loaded || ev.source !== parent || !ev.data || ev.data.type !== "load") return;
    loaded = true;
    var msg = ev.data;
    var fetchList = (msg.mod.manifest.permissions && msg.mod.manifest.permissions.fetch) || [];
    var connect = fetchList === "*" ? "https: wss:" : fetchList.join(" ") || "'none'";
    var meta = document.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = "default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src " + connect;
    document.head.appendChild(meta);
    window.__modLoad = msg;
    try {
      (0, Function)(msg.code)();
    } catch (err) {
      parent.postMessage({ type: "load-failed", error: String((err && err.stack) || err) }, "*");
    }
  });
  parent.postMessage({ type: "booted" }, "*");
})();
