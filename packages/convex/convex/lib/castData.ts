// The live data runtime every published page with queries gets (served at
// /cli/data.js, injected by artifactsHttp.serve when the page uses
// <cast-chart>, <cast-stat> or cast.data). The script tag carries the page's
// data endpoint, gate tokens included, in data-endpoint.
//
//   window.cast.data(id)          -> Promise<{columns, rows, refreshed_at, query_text, stale, error?}>
//   window.cast.subscribe(id, cb) -> unsubscribe; cb runs now (once loaded) and on every new answer
//
//   <cast-chart query="done" type="line|area|bar|table" x="day" y="done" series="group" title="…" height="220">
//   <cast-stat query="spend" field="spend" agg="last|sum|avg|min|max|count" format="number|usd|percent" label="…">
//
// One poll for the whole page: it asks again when the soonest subscribed
// query is due, and every few seconds while one is still being refreshed.
// Charts are Observable Plot (loaded from a CDN on first use), coloured from
// the page's --sol-* theme tokens and redrawn when the theme changes.
//
// Kept as source text for the same reason as castPlayer.ts: plain ES5 inside
// a String.raw template, so it must never contain a backtick or a dollar brace.
const CAST_DATA = String.raw`(function () {
  if (window.cast && window.cast.__data) return;
  var script = document.currentScript;
  var endpoint = script && script.getAttribute("data-endpoint");
  if (!endpoint) return;
  var results = {}, subs = {}, waiters = [], loaded = false, failure = null, timer = null, inflight = null, quickTries = 0;

  function urlFor() { return endpoint + (endpoint.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(); }
  function same(a, b) { return a && b && a.refreshed_at === b.refreshed_at && a.error === b.error && a.stale === b.stale && a.refreshing === b.refreshing; }

  function load() {
    if (inflight) return inflight;
    inflight = fetch(urlFor(), { cache: "no-store" }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : "HTTP " + r.status);
        return body;
      });
    }).then(function (body) {
      var next = body.queries || {};
      failure = null;
      Object.keys(next).forEach(function (id) {
        var prev = results[id];
        results[id] = next[id];
        if (!same(prev, next[id])) (subs[id] || []).forEach(function (cb) { safe(cb, next[id]); });
      });
      loaded = true;
    }).catch(function (e) {
      failure = e && e.message ? e.message : String(e);
    }).then(function () {
      inflight = null;
      var w = waiters; waiters = [];
      w.forEach(function (f) { f(); });
      schedule();
    });
    return inflight;
  }

  function safe(cb, v) { try { cb(v); } catch (e) { setTimeout(function () { throw e; }); } }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    var ids = Object.keys(subs).filter(function (id) { return subs[id].length; });
    if (!ids.length || document.hidden) return;
    var now = Date.now(), wait = Infinity, pending = false;
    ids.forEach(function (id) {
      var r = results[id];
      if (!r) return;
      if (r.refreshing || (r.stale && !r.error) || (!r.refreshed_at && !r.error)) pending = true;
      var due = (r.refreshed_at || now) + (r.refresh_ms || 900000) - now;
      wait = Math.min(wait, due);
    });
    if (failure) wait = 30000;
    else if (pending) { quickTries++; wait = Math.min(30000, 2500 * Math.pow(1.4, quickTries)); }
    else { quickTries = 0; wait = Math.max(5000, wait + 1500); }
    if (!isFinite(wait)) wait = 60000;
    timer = setTimeout(load, wait);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });

  function data(id) {
    return new Promise(function (resolve, reject) {
      function answer() {
        if (results[id]) resolve(results[id]);
        else if (failure) reject(new Error(failure));
        else reject(new Error("This page declares no query \"" + id + "\""));
      }
      if (loaded) { answer(); return; }
      waiters.push(answer);
      load();
    });
  }
  function subscribe(id, cb) {
    (subs[id] = subs[id] || []).push(cb);
    if (results[id]) safe(cb, results[id]);
    if (!loaded || !timer) load();
    return function () {
      subs[id] = (subs[id] || []).filter(function (f) { return f !== cb; });
    };
  }
  window.cast = window.cast || {};
  window.cast.data = data;
  window.cast.subscribe = subscribe;
  window.cast.__data = true;

  // ── shared bits for the two elements ──

  function ago(ms) {
    if (!ms) return "Loading…";
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 45) return "Updated just now";
    if (s < 3600) return "Updated " + Math.round(s / 60) + " min ago";
    if (s < 86400) return "Updated " + Math.round(s / 3600) + " h ago";
    return "Updated " + Math.round(s / 86400) + " d ago";
  }
  setInterval(function () {
    Array.prototype.forEach.call(document.querySelectorAll("cast-chart, cast-stat"), function (el) { if (el._stamp) el._stamp(); });
  }, 30000);

  var BASE_CSS =
    ":host{display:block;font:inherit;color:var(--sol-text,#002b36);min-width:0}" +
    ".title{font-size:.8125rem;font-weight:600;color:var(--sol-text-secondary,var(--sol-text,#073642));margin:0 0 .5rem;letter-spacing:.01em}" +
    ".foot{display:flex;gap:.75rem;align-items:baseline;margin-top:.5rem;font-size:.6875rem;color:var(--sol-text-dim,#657b83);font-variant-numeric:tabular-nums}" +
    ".foot button{all:unset;cursor:pointer;color:var(--sol-text-dim,#657b83);text-decoration:underline;text-decoration-color:color-mix(in srgb,currentColor 35%,transparent);text-underline-offset:2px}" +
    ".foot button:hover,.foot button:focus-visible{color:var(--sol-text,#002b36)}" +
    ".err{color:var(--sol-red,#dc322f)}" +
    "pre{margin:.5rem 0 0;padding:.5rem .625rem;white-space:pre-wrap;word-break:break-word;font:.6875rem/1.5 var(--font-mono,ui-monospace,monospace);color:var(--sol-text-muted,#586e75);background:color-mix(in srgb,var(--sol-text,#002b36) 5%,transparent);border-radius:6px}" +
    ".empty{display:flex;align-items:center;justify-content:center;color:var(--sol-text-dim,#657b83);font-size:.75rem}";

  function frame(el, extraCss) {
    var root = el.attachShadow({ mode: "open" });
    root.innerHTML = "<style>" + BASE_CSS + (extraCss || "") + "</style><div class=\"title\" part=\"title\" hidden></div><div class=\"body\" part=\"body\"></div>" +
      "<div class=\"foot\" part=\"footer\"><span class=\"when\"></span><button type=\"button\" class=\"q\" aria-expanded=\"false\">Query</button><span class=\"err\" hidden></span></div><pre hidden></pre>";
    var q = root.querySelector(".q"), pre = root.querySelector("pre");
    q.addEventListener("click", function () {
      var open = pre.hasAttribute("hidden");
      if (open) pre.removeAttribute("hidden"); else pre.setAttribute("hidden", "");
      q.setAttribute("aria-expanded", String(open));
    });
    return root;
  }

  function paintMeta(el, root, r) {
    var title = el.getAttribute("title") || el.getAttribute("label") || (r && r.title) || "";
    var t = root.querySelector(".title");
    if (el.tagName === "CAST-CHART") { t.textContent = title; if (title) t.removeAttribute("hidden"); else t.setAttribute("hidden", ""); }
    root.querySelector("pre").textContent = r ? r.query_text + (r.truncated ? "\n(rows cut to fit)" : "") : "";
    var err = root.querySelector(".err");
    if (r && r.error) { err.textContent = "Couldn't refresh: " + r.error; err.removeAttribute("hidden"); } else err.setAttribute("hidden", "");
    el._stamp = function () {
      var when = root.querySelector(".when");
      when.textContent = r ? (r.refreshing && !r.refreshed_at ? "Loading…" : ago(r.refreshed_at)) : "Loading…";
      if (r && r.refreshed_at) when.title = new Date(r.refreshed_at).toLocaleString();
    };
    el._stamp();
  }

  function colIndex(r, name, fallback) {
    if (!r) return -1;
    if (name) return r.columns.indexOf(name);
    return fallback;
  }
  var DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
  function cell(v) { return typeof v === "string" && DATE.test(v) ? new Date(v.length === 10 ? v + "T00:00:00Z" : v) : v; }

  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    var get = function (n, d) { return (cs.getPropertyValue(n) || "").trim() || d; };
    return {
      text: get("--sol-text-muted", "#586e75"),
      series: ["--sol-blue", "--sol-cyan", "--sol-green", "--sol-yellow", "--sol-orange", "--sol-magenta", "--sol-violet", "--sol-red"].map(function (n, i) {
        return get(n, ["#268bd2", "#2aa198", "#859900", "#b58900", "#cb4b16", "#d33682", "#6c71c4", "#dc322f"][i]);
      }),
    };
  }

  // ── Plot, once ──
  var plotReady = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }
  function plot() {
    if (window.Plot) return Promise.resolve(window.Plot);
    if (!plotReady) {
      plotReady = (window.d3 ? Promise.resolve() : loadScript("https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"))
        .then(function () { return loadScript("https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6/dist/plot.umd.min.js"); })
        .then(function () { return window.Plot; });
    }
    return plotReady;
  }

  var charts = [];
  function redrawAll() { charts.forEach(function (c) { if (c.isConnected && c._draw) c._draw(); }); }
  var themeStyle = document.getElementById("cc-page-theme");
  if (themeStyle && window.MutationObserver) new MutationObserver(redrawAll).observe(themeStyle, { childList: true, characterData: true, subtree: true });
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", redrawAll);
  }

  // ── <cast-chart> ──
  function CastChart() { return Reflect.construct(HTMLElement, [], CastChart); }
  CastChart.prototype = Object.create(HTMLElement.prototype);
  CastChart.prototype.constructor = CastChart;
  Object.setPrototypeOf(CastChart, HTMLElement);
  CastChart.prototype.connectedCallback = function () {
    var el = this;
    if (el._root) { if (!el._unsub && el.getAttribute("query")) el._unsub = subscribe(el.getAttribute("query"), function (r) { el._result = r; el._draw(); }); return; }
    el._root = frame(el, ".body{min-height:var(--h)}.body svg{display:block;overflow:visible}" +
      "table{width:100%;border-collapse:collapse;font-size:.75rem;font-variant-numeric:tabular-nums}" +
      "th{text-align:left;font-weight:600;color:var(--sol-text-muted,#586e75);border-bottom:1px solid color-mix(in srgb,var(--sol-border,#93a1a1) 60%,transparent);padding:.375rem .5rem .375rem 0}" +
      "td{padding:.3125rem .5rem .3125rem 0;border-bottom:1px solid color-mix(in srgb,var(--sol-border,#93a1a1) 22%,transparent);vertical-align:top}" +
      "td.n,th.n{text-align:right}.scroll{max-height:var(--h);overflow:auto}");
    el._root.host.style.setProperty("--h", (parseInt(el.getAttribute("height"), 10) || 220) + "px");
    charts.push(el);
    var lastWidth = 0;
    if (window.ResizeObserver) new ResizeObserver(function () {
      var w = el.clientWidth;
      if (w && Math.abs(w - lastWidth) > 4) { lastWidth = w; if (el._result) el._draw(); }
    }).observe(el);
    var id = el.getAttribute("query");
    if (!id) { el._root.querySelector(".body").innerHTML = "<div class=\"empty\">cast-chart needs a query attribute</div>"; return; }
    el._unsub = subscribe(id, function (r) { el._result = r; el._draw(); });
    data(id).catch(function (e) {
      el._root.querySelector(".body").innerHTML = "";
      var d = document.createElement("div"); d.className = "empty err"; d.textContent = e.message; el._root.querySelector(".body").appendChild(d);
    });
  };
  CastChart.prototype.disconnectedCallback = function () { if (this._unsub) { this._unsub(); this._unsub = null; } };
  CastChart.prototype._draw = function () {
    var el = this, r = el._result, root = el._root;
    if (!root) return;
    paintMeta(el, root, r);
    var body = root.querySelector(".body"), h = parseInt(el.getAttribute("height"), 10) || 220;
    if (!r) return;
    if (!r.rows.length) { body.innerHTML = "<div class=\"empty\" style=\"height:" + h + "px\">" + (r.refreshed_at ? "No rows" : "Loading…") + "</div>"; return; }
    var type = el.getAttribute("type") || "line";
    if (type === "table") { body.innerHTML = ""; body.appendChild(table(r)); return; }
    var xi = colIndex(r, el.getAttribute("x"), 0);
    var yi = colIndex(r, el.getAttribute("y"), r.columns.length - 1);
    var si = colIndex(r, el.getAttribute("series"), r.columns.length === 3 && r.columns[1] !== r.columns[yi] && typeof r.rows[0][1] === "string" ? 1 : -1);
    if (xi < 0 || yi < 0) { body.innerHTML = "<div class=\"empty\">No column " + (xi < 0 ? el.getAttribute("x") : el.getAttribute("y")) + " (has: " + r.columns.join(", ") + ")</div>"; return; }
    var rows = r.rows.map(function (row) { return { x: cell(row[xi]), y: Number(row[yi]) || 0, s: si >= 0 ? String(row[si]) : "" }; });
    plot().then(function (Plot) {
      if (el._result !== r) return;
      var c = themeColors(), width = el.clientWidth || 640, temporal = rows[0].x instanceof Date;
      var hourly = temporal && r.columns[xi] === "hour";
      var series = si >= 0;
      var color = { range: c.series, legend: series };
      var common = { x: "x", y: "y" };
      var marks = [Plot.ruleY([0], { stroke: c.text, strokeOpacity: 0.25 })];
      var opts = { width: width, height: h, marginLeft: 44, style: { color: c.text, background: "transparent", fontFamily: "inherit", fontSize: "11px", overflow: "visible" }, color: color, y: { grid: true, label: null, nice: true }, x: { label: null } };
      if (type === "bar" && !temporal) {
        opts.marginLeft = 120; opts.y = { label: null }; opts.x = { grid: true, label: null, nice: true };
        opts.height = Math.max(h, rows.length * 22 + 30);
        marks.length = 0;
        marks.push(Plot.ruleX([0], { stroke: c.text, strokeOpacity: 0.25 }));
        marks.push(Plot.barX(rows, { y: "x", x: "y", fill: series ? "s" : c.series[0], sort: { y: "-x" }, tip: true }));
      } else if (type === "bar") {
        opts.x = { type: "utc", label: null };
        marks.push(Plot.rectY(rows, Plot.stackY({ x: "x", interval: hourly ? "hour" : "day", y: "y", fill: series ? "s" : c.series[0], tip: true, inset: 1 })));
      } else if (type === "area") {
        if (temporal) opts.x = { type: "utc", label: null };
        marks.push(Plot.areaY(rows, Plot.stackY(Object.assign({ fill: series ? "s" : c.series[0], fillOpacity: series ? 0.85 : 0.22 }, common))));
        if (!series) marks.push(Plot.lineY(rows, Object.assign({ stroke: c.series[0], strokeWidth: 1.75 }, common)));
        marks.push(Plot.tip(rows, Plot.pointerX(Object.assign({}, common, { fill: series ? "s" : undefined }))));
      } else {
        if (temporal) opts.x = { type: "utc", label: null };
        marks.push(Plot.lineY(rows, Object.assign({ stroke: series ? "s" : c.series[0], strokeWidth: 1.75, curve: "monotone-x" }, common)));
        marks.push(Plot.dot(rows, Plot.pointerX(Object.assign({ fill: series ? "s" : c.series[0], r: 3 }, common))));
        marks.push(Plot.tip(rows, Plot.pointerX(Object.assign({}, common, series ? { channels: { series: "s" } } : {}))));
      }
      opts.marks = marks;
      var svg = Plot.plot(opts);
      body.innerHTML = "";
      body.appendChild(svg);
    }).catch(function (e) {
      body.innerHTML = "";
      var d = document.createElement("div"); d.className = "empty err"; d.textContent = e.message; body.appendChild(d);
    });
  };

  function table(r) {
    var wrap = document.createElement("div"); wrap.className = "scroll";
    var t = document.createElement("table"), head = document.createElement("tr");
    var numeric = r.columns.map(function (_, i) { return r.rows.every(function (row) { return row[i] === null || typeof row[i] === "number"; }); });
    r.columns.forEach(function (c, i) { var th = document.createElement("th"); th.textContent = c; if (numeric[i]) th.className = "n"; head.appendChild(th); });
    var thead = document.createElement("thead"); thead.appendChild(head); t.appendChild(thead);
    var tb = document.createElement("tbody");
    r.rows.slice(0, 500).forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (v, i) { var td = document.createElement("td"); td.textContent = v === null ? "" : numeric[i] ? Number(v).toLocaleString() : String(v); if (numeric[i]) td.className = "n"; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }

  // ── <cast-stat> ──
  function format(v, how) {
    if (v === null || v === undefined || isNaN(v)) return "–";
    if (how === "usd") return Math.abs(v) >= 10000 ? "$" + (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "k" : "$" + v.toLocaleString(undefined, { minimumFractionDigits: Math.abs(v) < 100 ? 2 : 0, maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 });
    if (how === "percent") return (v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "M";
    if (Math.abs(v) >= 1e4) return (v / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "k";
    return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function aggregate(values, agg) {
    var nums = values.map(Number).filter(function (n) { return !isNaN(n); });
    if (agg === "count") return values.length;
    if (!nums.length) return null;
    if (agg === "sum") return nums.reduce(function (a, b) { return a + b; }, 0);
    if (agg === "avg") return nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
    if (agg === "min") return Math.min.apply(null, nums);
    if (agg === "max") return Math.max.apply(null, nums);
    if (agg === "first") return nums[0];
    return nums[nums.length - 1];
  }
  function CastStat() { return Reflect.construct(HTMLElement, [], CastStat); }
  CastStat.prototype = Object.create(HTMLElement.prototype);
  CastStat.prototype.constructor = CastStat;
  Object.setPrototypeOf(CastStat, HTMLElement);
  CastStat.prototype.connectedCallback = function () {
    var el = this;
    if (el._root) { if (!el._unsub) el._unsub = subscribe(el.getAttribute("query"), function (r) { el._result = r; el._draw(); }); return; }
    el._root = frame(el, ".label{font-size:.75rem;color:var(--sol-text-muted,#586e75);margin-bottom:.25rem}" +
      ".value{font-size:2rem;line-height:1.1;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--sol-text,#002b36)}" +
      ".value.wait{color:var(--sol-text-dim,#657b83)}");
    el._root.querySelector(".body").innerHTML = "<div class=\"label\" part=\"label\"></div><div class=\"value wait\" part=\"value\">–</div>";
    var id = el.getAttribute("query");
    el._unsub = subscribe(id, function (r) { el._result = r; el._draw(); });
    data(id).catch(function (e) { el._root.querySelector(".value").textContent = "–"; var err = el._root.querySelector(".err"); err.textContent = e.message; err.removeAttribute("hidden"); });
  };
  CastStat.prototype.disconnectedCallback = CastChart.prototype.disconnectedCallback;
  CastStat.prototype._draw = function () {
    var el = this, r = el._result, root = el._root;
    if (!root) return;
    paintMeta(el, root, r);
    root.querySelector(".label").textContent = el.getAttribute("label") || (r && r.title) || el.getAttribute("query");
    var value = root.querySelector(".value");
    if (!r || (!r.rows.length && !r.refreshed_at)) { value.textContent = "–"; value.className = "value wait"; return; }
    var fi = colIndex(r, el.getAttribute("field"), r.columns.length - 1);
    if (fi < 0) { value.textContent = "–"; root.querySelector(".label").textContent += " (no column " + el.getAttribute("field") + ")"; return; }
    var v = aggregate(r.rows.map(function (row) { return row[fi]; }), el.getAttribute("agg") || "last");
    var next = format(v, el.getAttribute("format") || "number");
    if (value.textContent !== next && value.className === "value" && value.animate) value.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 420, easing: "ease-out" });
    value.textContent = next;
    value.className = "value";
  };

  if (!customElements.get("cast-chart")) customElements.define("cast-chart", CastChart);
  if (!customElements.get("cast-stat")) customElements.define("cast-stat", CastStat);
})();`;

export const CAST_DATA_JS = CAST_DATA + "\n";
