// window.cast.app: the page side of an installed app's bridge
// (docs/architecture/installed-apps.md). Both hosts run this before the page's
// own scripts: Electron through appPreload.js, the macOS shim as a
// document-start WKUserScript. In a browser tab nothing injects it, so
// window.cast.app stays undefined.
//
// Transports:
//   Electron  window.__castAppTransport = {call(msg) -> Promise<reply>, onEvent(cb)}
//             (contextBridge, appPreload.js)
//   WKWebView window.webkit.messageHandlers.castApp.postMessage(msg) -> Promise<reply>
//             (WKScriptMessageHandlerWithReply); the shim delivers host events by
//             calling window.__castAppEvent({event, data}).
//
// It only adds window.cast.app and leaves the rest of window.cast alone, as
// the live data runtime (convex/lib/castData.ts) does for its own keys.
// Plain ES2017, no build step.
(function () {
  "use strict";
  var w = window;
  if (w.cast && w.cast.app) return;

  function electronTransport() {
    var t = w.__castAppTransport;
    return t && typeof t.call === "function" ? t : null;
  }
  function webkitTransport() {
    var handler = w.webkit && w.webkit.messageHandlers && w.webkit.messageHandlers.castApp;
    if (!handler) return null;
    var sinks = [];
    w.__castAppEvent = function (ev) {
      sinks.forEach(function (cb) { cb(ev); });
    };
    return {
      call: function (msg) { return handler.postMessage(msg); },
      onEvent: function (cb) { sinks.push(cb); },
    };
  }
  var transport = electronTransport() || webkitTransport();
  if (!transport) return;

  function codedError(code, message) {
    var e = new Error(message || code);
    e.code = code;
    return e;
  }

  var seq = 0;
  function call(module, method, args) {
    while (args.length && args[args.length - 1] === undefined) args.pop();
    var msg = { id: "c" + ++seq, module: module, method: method, args: args };
    return Promise.resolve()
      .then(function () { return transport.call(msg); })
      .then(
        function (reply) {
          if (reply && reply.ok) return reply.value;
          throw codedError((reply && reply.code) || "failed", reply && reply.message);
        },
        function (err) {
          throw codedError("failed", (err && err.message) || String(err));
        }
      );
  }

  var listeners = {};
  var watchers = {};
  transport.onEvent(function (ev) {
    if (!ev || typeof ev.event !== "string") return;
    if (ev.event === "fs-change" && ev.data && watchers[ev.data.watchId]) {
      safe(watchers[ev.data.watchId], ev.data);
    }
    (listeners[ev.event] || []).slice().forEach(function (cb) { safe(cb, ev.data); });
  });
  function safe(cb, data) {
    try { cb(data); } catch (e) { setTimeout(function () { throw e; }); }
  }

  function method(module, name) {
    return function () { return call(module, name, Array.prototype.slice.call(arguments)); };
  }

  var app = {
    info: method("app", "info"),
    badge: method("app", "badge"),
    openInCodecast: method("app", "openInCodecast"),
    notify: method("app", "notify"),
    permissions: { request: method("permissions", "request") },
    tray: { set: method("tray", "set"), remove: method("tray", "remove") },
    shortcuts: { register: method("shortcuts", "register"), unregister: method("shortcuts", "unregister") },
    window: {
      setSize: method("window", "setSize"),
      setTitle: method("window", "setTitle"),
      focus: method("window", "focus"),
      minimize: method("window", "minimize"),
      close: method("window", "close"),
      setAlwaysOnTop: method("window", "setAlwaysOnTop"),
      setVisibleOnAllWorkspaces: method("window", "setVisibleOnAllWorkspaces"),
      setIgnoreMouseEvents: method("window", "setIgnoreMouseEvents"),
    },
    agent: { ask: method("agent", "ask") },
    login: { set: method("login", "set") },
    fs: {
      readText: method("fs", "readText"),
      writeText: method("fs", "writeText"),
      list: method("fs", "list"),
      stat: method("fs", "stat"),
      remove: method("fs", "remove"),
      // Resolves to a function that stops the watch.
      watch: function (path, cb) {
        if (typeof cb !== "function") return Promise.reject(codedError("bad-args", "fs.watch needs a callback"));
        return call("fs", "watch", [path]).then(function (watchId) {
          watchers[watchId] = cb;
          return function stop() {
            delete watchers[watchId];
            return call("fs", "unwatch", [watchId]);
          };
        });
      },
    },
    process: { run: method("process", "run") },
    shell: { open: method("shell", "open") },
    on: function (event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return function () { app.off(event, cb); };
    },
    off: function (event, cb) {
      listeners[event] = (listeners[event] || []).filter(function (f) { return f !== cb; });
    },
  };

  function freeze(o) {
    Object.keys(o).forEach(function (k) { if (o[k] && typeof o[k] === "object") freeze(o[k]); });
    return Object.freeze(o);
  }
  w.cast = w.cast || {};
  Object.defineProperty(w.cast, "app", { value: freeze(app), enumerable: true });
})();
