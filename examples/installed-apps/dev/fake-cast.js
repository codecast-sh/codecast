// A stand-in for what a.codecast.sh and an installed-app host give a page,
// for trying the examples on localhost. dev/serve.mjs injects it before the
// page's own scripts; a published page never carries it.
//
//   cast.data / cast.subscribe   fixtures per app (FIXTURES below); __fake.data(id, rows) swaps them live
//   cast.state                   collections in localStorage, live across tabs of the same origin
//   cast.me                      ?me=<name> (default Ada)
//   cast.app                     only with ?app=window|tray (openInCodecast shows the route it would open), granted ?grants=a,b; refusals with
//                                ?deny=<permission>:<code>. Notifications and the badge show in a
//                                small dev strip; clicking a notification fires notification-click.
(function () {
  var params = new URLSearchParams(location.search);
  var appName = location.pathname.split("/").filter(Boolean)[0] || "";
  var me = params.get("me") || "Ada";
  var now = Date.now();
  var H = 3600e3;
  var iso = function (ago) { return new Date(now - ago).toISOString(); };

  var M = 60e3;
  var FIXTURES = {
    "needs-you": {
      waiting: {
        columns: ["kind", "ref", "title", "detail", "since", "url"],
        rows: [
          ["decision", "sd-4635", "Ship the schema change before the web push?", "Deploy the convex half first", iso(4 * M), "https://codecast.sh/decisions/sd-4635"],
          ["task", "ct-101454", "Review: install published pages as desktop apps", "in review", iso(38 * M), "https://codecast.sh/tasks/ct-101454"],
          ["session", "jx7c6zk", "Fix the sync race in the inbox store", "Blocked: needs a prod key before the last check", iso(1.6 * H), "https://codecast.sh/conversation/jx7c6zk"],
          ["decision", "sd-4610", "Which icon for the Needs you app?", "Needs you example", iso(3 * H), "https://codecast.sh/decisions/sd-4610"],
          ["task", "ct-99821", "Cut the CLI release", "blocked", iso(26 * H), "https://codecast.sh/tasks/ct-99821"],
        ],
      },
    },
    "team-queue": {
      tasks: { columns: ["status", "tasks"], rows: [["in_review", 3], ["open", 7], ["in_progress", 4], ["backlog", 11], ["done", 23]] },
      mine: { columns: ["assignee", "tasks"], rows: [[me, 5], ["Sam", 9], ["(unassigned)", 6]] },
      incidents: {
        columns: ["group", "title", "kind", "status", "count", "last_seen"],
        rows: [
          ["eg-412", "TypeError: Cannot read properties of undefined (reading 'session_id')", "error", "open", 184, iso(0.2 * H)],
          ["eg-409", "sync push timed out after 30s", "error", "open", 41, iso(1.4 * H)],
          ["eg-398", "Health check failed: convex-prod /version", "health", "open", 6, iso(5 * H)],
        ],
      },
    },
  };

  // ── live data ──
  var tables = FIXTURES[appName] || {};
  var subs = {};
  function answer(id) {
    var t = tables[id];
    if (!t) return { columns: [], rows: [], refreshed_at: Date.now(), error: "no fixture for query " + id, stale: false };
    return { columns: t.columns, rows: t.rows, refreshed_at: t.refreshed_at || now, query_text: "fixture", stale: false };
  }
  window.cast = window.cast || {};
  window.cast.data = function (id) { return new Promise(function (r) { setTimeout(function () { r(answer(id)); }, 120); }); };
  window.cast.subscribe = function (id, cb) {
    (subs[id] = subs[id] || []).push(cb);
    setTimeout(function () { cb(answer(id)); }, 120);
    return function () { subs[id] = subs[id].filter(function (f) { return f !== cb; }); };
  };

  // ── page state ──
  var bc = "BroadcastChannel" in window ? new BroadcastChannel("fake-state:" + appName) : null;
  var listeners = {};
  function storeKey(c) { return "fake-state:" + appName + ":" + c; }
  function read(c) { try { return JSON.parse(localStorage.getItem(storeKey(c))) || []; } catch (e) { return []; } }
  function view(c) {
    return read(c).map(function (r) { return { key: r.key, value: r.value, by: r.by, agent: null, mine: !!r.by && r.by.name === me, created_at: r.created_at, updated_at: r.updated_at }; });
  }
  function emit(c) { (listeners[c] || []).forEach(function (cb) { cb(view(c)); }); }
  if (bc) bc.onmessage = function (e) { emit(e.data); };
  window.addEventListener("storage", function (e) { if (e.key && e.key.indexOf("fake-state:" + appName + ":") === 0) emit(e.key.split(":").pop()); });
  var seq = 0;
  function write(c, op, key, value) {
    var rows = read(c);
    var at = Date.now();
    var i = rows.findIndex(function (r) { return r.key === key; });
    if (op === "insert") key = at.toString(36).padStart(9, "0") + (seq++).toString(36).padStart(6, "0");
    if (op === "delete") { if (i >= 0) rows.splice(i, 1); }
    else if (op === "clear") rows = [];
    else if (i >= 0 && rows[i].by && rows[i].by.name !== me && !params.has("editor")) return Promise.reject(new Error("only " + rows[i].by.name + " can change this row"));
    else if (i >= 0) { rows[i].value = op === "patch" ? Object.assign({}, rows[i].value, value) : value; rows[i].updated_at = at; }
    else rows.push({ key: key, value: value, by: { name: me, avatar: null }, created_at: at, updated_at: at });
    rows.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    localStorage.setItem(storeKey(c), JSON.stringify(rows));
    emit(c);
    if (bc) bc.postMessage(c);
    return Promise.resolve({ key: key });
  }
  window.cast.state = function (c) {
    return {
      list: function () { return Promise.resolve(view(c)); },
      subscribe: function (cb) {
        (listeners[c] = listeners[c] || []).push(cb);
        setTimeout(function () { cb(view(c)); }, 60);
        return function () { listeners[c] = listeners[c].filter(function (f) { return f !== cb; }); };
      },
      get: function (k) { var r = view(c).find(function (x) { return x.key === String(k); }); return Promise.resolve(r ? r.value : undefined); },
      watch: function () { throw new Error("watch is not faked"); },
      set: function (k, v) { return write(c, "set", String(k), v).then(function (r) { return r.key; }); },
      insert: function (v) { return write(c, "insert", null, v).then(function (r) { return r.key; }); },
      patch: function (k, v) { return write(c, "patch", String(k), v).then(function (r) { return r.key; }); },
      remove: function (k) { return write(c, "delete", String(k)).then(function () {}); },
      clear: function () { return write(c, "clear").then(function () { return 0; }); },
    };
  };
  window.cast.me = function () { return Promise.resolve({ name: me, avatar: null, signed_in: true, owner: true, editor: true, collections: [] }); };

  // A teammate's write, for trying notifications: __fake.as("Sam", "standup", key, value).
  window.__fake = {
    data: function (id, rows) { tables[id] = { columns: tables[id].columns, rows: rows, refreshed_at: Date.now() }; (subs[id] || []).forEach(function (cb) { cb(answer(id)); }); },
    as: function (who, c, key, value) {
      var rows = read(c);
      var at = Date.now();
      var i = rows.findIndex(function (r) { return r.key === key; });
      if (i >= 0) { rows[i].value = value; rows[i].updated_at = at; rows[i].by = { name: who, avatar: null }; }
      else rows.push({ key: key, value: value, by: { name: who, avatar: null }, created_at: at, updated_at: at });
      localStorage.setItem(storeKey(c), JSON.stringify(rows));
      emit(c);
      if (bc) bc.postMessage(c);
    },
    reset: function (c) { localStorage.removeItem(storeKey(c)); emit(c); },
  };

  // ── cast.app ──
  // Under dev/electron-run.mjs the host's real cast.app is here (frozen), and
  // the runner asks for notifications to be recorded rather than shown, so a
  // run never puts them on the person's screen: the page gets a copy whose
  // notify only records (window.__sent).
  if (window.__castRecordNotify && window.cast.app) {
    var sent = window.__sent = [];
    window.cast = Object.assign({}, window.cast, {
      app: Object.assign({}, window.cast.app, { notify: function (n) { sent.push(n); return Promise.resolve(); } }),
    });
    return;
  }
  var surface = params.get("app");
  if (surface !== "window" && surface !== "tray") return;
  var grants = (params.get("grants") || "").split(",").filter(Boolean);
  var denied = {};
  (params.get("deny") || "").split(",").filter(Boolean).forEach(function (d) { var p = d.split(":"); denied[p[0]] = p[1] || "denied"; });
  var handlers = {};
  var log = [];
  function fire(event, data) { (handlers[event] || []).forEach(function (cb) { cb(data); }); }
  function refuse(code, message) { var e = new Error(message || code); e.code = code; return Promise.reject(e); }
  function needs(permission, fn) {
    return function () {
      log.push([permission].concat([].slice.call(arguments)));
      if (denied[permission]) return refuse(denied[permission]);
      if (grants.indexOf(permission) < 0) return refuse("needs-consent", permission + " is not granted for this version");
      return Promise.resolve(fn.apply(null, arguments));
    };
  }
  var strip;
  function devStrip() {
    if (strip) return strip;
    strip = document.createElement("div");
    strip.setAttribute("style", "position:fixed;z-index:2147483647;right:8px;bottom:8px;display:flex;flex-direction:column;gap:6px;align-items:flex-end;font:12px/1.35 -apple-system,system-ui;pointer-events:none");
    document.documentElement.appendChild(strip);
    return strip;
  }
  function devNote(html, onClick) {
    var n = document.createElement("div");
    n.setAttribute("style", "pointer-events:auto;max-width:280px;background:rgba(30,30,32,.92);color:#fff;padding:8px 10px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);cursor:" + (onClick ? "pointer" : "default"));
    n.innerHTML = html;
    if (onClick) n.onclick = function () { onClick(); n.remove(); };
    devStrip().appendChild(n);
    setTimeout(function () { n.remove(); }, 9000);
  }
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var accelerators = [];
  window.addEventListener("keydown", function (e) {
    accelerators.forEach(function (a) {
      var parts = a.toLowerCase().split("+");
      var key = parts.pop();
      var want = { cmd: parts.indexOf("cmdorctrl") >= 0 || parts.indexOf("cmd") >= 0, shift: parts.indexOf("shift") >= 0, alt: parts.indexOf("alt") >= 0 };
      if (e.key.toLowerCase() === key && (e.metaKey || e.ctrlKey) === want.cmd && e.shiftKey === want.shift && e.altKey === want.alt) { e.preventDefault(); fire("shortcut", { accelerator: a }); }
    });
  });
  var noGrant = function (name) { return function () { log.push([name].concat([].slice.call(arguments))); return Promise.resolve(); }; };
  var fileRefusal = function () { return refuse("failed", "the dev fake runs no files or programs; use dev/electron-run.mjs"); };
  window.cast.app = {
    info: function () { return Promise.resolve({ slug: appName, name: appName, version: 1, surface: surface, platform: "darwin", grants: grants.slice(), requested: grants.slice() }); },
    permissions: {
      request: function (asked) {
        log.push(["permissions.request", asked]);
        var refused = asked.filter(function (p) { return denied[p]; });
        if (refused.length) return refuse(denied[refused[0]]);
        asked.forEach(function (p) { if (grants.indexOf(p) < 0) grants.push(p); });
        setTimeout(function () { fire("grants", { grants: grants.slice(), version: 1 }); });
        return Promise.resolve(grants.slice());
      },
    },
    notify: needs("notifications", function (n) {
      devNote("<b>" + esc(n.title) + "</b><br>" + esc(n.body) + '<div style="opacity:.5;margin-top:2px">notification · tag ' + esc(n.tag) + "</div>", function () { fire("notification-click", { tag: n.tag }); });
    }),
    openInCodecast: function (route) { log.push(["openInCodecast", route]); devNote("<b>Opens in Codecast</b><br>" + esc(route)); return Promise.resolve(); },
    badge: function (n) { log.push(["badge", n]); document.title = document.title.replace(/^\(\d+\) /, "") ; if (n) document.title = "(" + n + ") " + document.title; return Promise.resolve(); },
    tray: { set: needs("menu-bar", function () {}), remove: needs("menu-bar", function () {}) },
    shortcuts: { register: needs("shortcuts", function (a) { accelerators.push(a); }), unregister: needs("shortcuts", function () {}) },
    window: {
      setAlwaysOnTop: needs("overlay", function () {}),
      setVisibleOnAllWorkspaces: needs("overlay", function () {}),
      setIgnoreMouseEvents: needs("overlay", function () {}),
      setSize: noGrant("window.setSize"), setTitle: noGrant("window.setTitle"), focus: noGrant("window.focus"), minimize: noGrant("window.minimize"), close: noGrant("window.close"),
    },
    agent: { ask: needs("agent", function () { return { answer: "(dev fake)" }; }) },
    login: { set: needs("login", function () {}) },
    fs: {
      readText: needs("full-access", fileRefusal), writeText: needs("full-access", fileRefusal), stat: needs("full-access", fileRefusal),
      list: needs("full-access", fileRefusal), remove: needs("full-access", fileRefusal), watch: needs("full-access", fileRefusal),
    },
    process: { run: needs("full-access", fileRefusal) },
    shell: { open: needs("full-access", fileRefusal) },
    on: function (event, cb) { (handlers[event] = handlers[event] || []).push(cb); return function () { window.cast.app.off(event, cb); }; },
    off: function (event, cb) { handlers[event] = (handlers[event] || []).filter(function (f) { return f !== cb; }); },
  };
  window.__fakeApp = { log: log, fire: fire, grants: grants };
})();
