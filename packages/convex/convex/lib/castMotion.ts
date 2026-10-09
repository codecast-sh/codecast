// The cast motion player: what a published page holding a HyperFrames
// composition plays in (served at /cli/motion.js and injected by
// artifactsHttp.serve after the HyperFrames runtime). It fits the composition's
// fixed-size stage into the window below the page bar, adds a transport (play,
// pause, a scrubber with the composition's beats and comment markers, frame
// steps, keyboard), stops at the end instead of looping, and offers the last
// MP4 render when the directory carries one (cast publish <dir> --render).
//
// It provides the page timeline every comment layer reads:
//   window.__castTimeline = { time, duration, seek, play, pause, playing, setMarkers }
// and dispatches "cast:timeline-ready" on window once it is assigned. A marker
// click seeks there and dispatches "cast:marker" ({ id, t, n }).
//
// Live numbers: an element with data-cast-data="<data id>" shows a value from
// window.cast.data (the page data runtime) and follows its updates, without a
// re-render. data-cast-col names the column (or its index; default 0),
// data-cast-row the row (default 0; negative counts from the end), and
// data-cast-format one of int, pct, usd, raw. The authored text stays when the
// data runtime is absent (a local render), so a render shows the numbers the
// page was written with. Scripts read a value with
// window.castMotion.value(id, col, row) -> Promise<number | string | null>.
//
// Kept as source text for the same reason as lib/castPlayer.ts: plain ES5 in a
// String.raw template, never a backtick or a dollar brace.
const DEFINE_CAST_MOTION = String.raw`function () {
  if (window.__castMotion) return;
  window.__castMotion = true;
  var root = null;
  var all = document.querySelectorAll("[data-composition-id][data-width][data-height]");
  for (var r = 0; r < all.length; r++) if (!all[r].hasAttribute("data-composition-src") && !all[r].closest("template")) { root = all[r]; break; }
  if (!root) return;
  var W = parseFloat(root.getAttribute("data-width")) || 1920, H = parseFloat(root.getAttribute("data-height")) || 1080;
  var FPS = parseFloat(root.getAttribute("data-fps")) || 30;
  var compId = root.getAttribute("data-composition-id");

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(t) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ":" + pad(Math.floor(s)) + "." + Math.floor((s % 1) * 10);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  // --- the clock: the runtime's player when it is up, else the bare timeline ---
  var own = { t: 0, playing: false, last: 0 };
  function hf() { return window.__player && window.__playerReady ? window.__player : null; }
  function tl() { var m = window.__timelines; return m && (m[compId] || m[Object.keys(m)[0]]) || null; }
  var declared = parseFloat(root.getAttribute("data-duration"));
  function duration() {
    if (declared > 0) return declared;
    var p = hf(); if (p) return p.getDuration() || 0;
    var x = tl(); return x ? x.duration() : 0;
  }
  function time() {
    var p = hf(); if (p) return p.getTime();
    return own.t;
  }
  function rawSeek(t) {
    var p = hf();
    if (p) { p.seek(t); return; }
    own.t = t; var x = tl(); if (x) x.seek(t, false);
  }
  function rawPlay() {
    var p = hf(); if (p) { p.play(); return; }
    own.playing = true; own.last = performance.now();
  }
  function rawPause() {
    var p = hf(); if (p) { p.pause(); return; }
    own.playing = false;
  }
  function isPlaying() { var p = hf(); return p ? !!p.isPlaying() : own.playing; }

  // --- stage and transport ---
  var CSS = [
    "html.__cm_on,html.__cm_on body{overflow:hidden!important;height:100%}",
    "html.__cm_on body{margin:0!important}",
    "html.__cm_on{background:#05080a!important}",
    "#__cm_stage{position:fixed;overflow:hidden;border-radius:6px;box-shadow:0 18px 60px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06);z-index:1}",
    "#__cm_scale{position:absolute;left:0;top:0;transform-origin:0 0}",
    "#__cm_hit{position:absolute;inset:0;z-index:2147483000;cursor:pointer;background:transparent}",
    "#__cm_hit[hidden]{display:none}",
    "#__cm_bar{--cm-ink:#eee8d5;--cm-dim:rgba(238,232,213,.5);--cm-line:rgba(238,232,213,.16);--cm-acc:#2aa198;--cm-hot:#cb4b16;position:fixed;left:0;right:0;bottom:0;height:56px;z-index:2147483600;display:flex;align-items:center;gap:10px;padding:0 calc(14px + env(safe-area-inset-right)) env(safe-area-inset-bottom) calc(10px + env(safe-area-inset-left));box-sizing:content-box;font:500 12px/1 'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--cm-ink);background:rgba(0,30,38,.86);-webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);border-top:1px solid var(--cm-line);user-select:none;-webkit-user-select:none}",
    "#__cm_bar button,#__cm_bar a{all:unset;box-sizing:border-box;cursor:pointer;height:34px;min-width:34px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;gap:6px;color:var(--cm-ink);flex:none;-webkit-tap-highlight-color:transparent;transition:background .12s ease}",
    "#__cm_bar button:hover,#__cm_bar a:hover{background:rgba(238,232,213,.1)}",
    "#__cm_bar button:focus-visible,#__cm_bar a:focus-visible{box-shadow:0 0 0 2px var(--cm-acc)}",
    "#__cm_bar svg{width:18px;height:18px;display:block}",
    "#__cm_pp{width:40px}",
    "#__cm_pp svg{width:20px;height:20px}",
    "#__cm_time{flex:none;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--cm-dim);min-width:15ch;text-align:center}",
    "#__cm_time b{color:var(--cm-ink);font-weight:600}",
    "#__cm_scrub{position:relative;flex:1;min-width:80px;height:40px;cursor:pointer;touch-action:none}",
    "#__cm_track{position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;border-radius:3px;background:var(--cm-line);overflow:hidden;transition:height .14s ease,margin .14s ease}",
    "#__cm_scrub:hover #__cm_track,#__cm_bar[data-drag] #__cm_track{height:6px;margin-top:-3px}",
    "#__cm_fill{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--cm-acc)}",
    ".__cm_tick{position:absolute;top:50%;width:2px;height:10px;margin:-5px 0 0 -1px;border-radius:1px;background:rgba(238,232,213,.34);pointer-events:none}",
    "#__cm_knob{position:absolute;top:50%;left:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:var(--cm-ink);box-shadow:0 0 0 4px color-mix(in srgb,var(--cm-acc) 45%,transparent);pointer-events:none}",
    "#__cm_tip{position:absolute;bottom:40px;left:0;transform:translateX(-50%);padding:5px 8px;border-radius:7px;background:#002b36;color:var(--cm-ink);font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s ease;box-shadow:0 6px 18px rgba(0,0,0,.35)}",
    "#__cm_scrub:hover #__cm_tip,#__cm_bar[data-drag] #__cm_tip{opacity:1}",
    ".__cm_mk{all:unset;position:absolute;top:1px;width:20px;height:20px;margin-left:-10px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#b58900;box-shadow:0 2px 6px rgba(0,0,0,.4),0 0 0 2px #002b36;cursor:pointer;display:grid;place-items:center;overflow:hidden;z-index:2;transition:transform .14s ease}",
    ".__cm_mk>span{transform:rotate(45deg);font:700 10px/1 'JetBrains Mono',ui-monospace,monospace;color:#000}",
    ".__cm_mk>img{transform:rotate(45deg);width:100%;height:100%;object-fit:cover}",
    ".__cm_mk:hover,.__cm_mk:focus-visible{transform:rotate(-45deg) scale(1.18)}",
    "#__cm_mtip{position:absolute;bottom:44px;left:0;transform:translateX(-50%);max-width:260px;padding:6px 9px;border-radius:7px;background:#fdf6e3;color:#002b36;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;opacity:0;transition:opacity .12s ease;box-shadow:0 6px 18px rgba(0,0,0,.35)}",
    "#__cm_mtip.__cm_in{opacity:1}",
    "#__cm_mtip i{font-style:normal;color:#657b83;margin-right:6px;font-variant-numeric:tabular-nums}",
    "#__cm_dl{padding:0 10px;border:1px solid var(--cm-line)}",
    "#__cm_dl[hidden]{display:none}",
    "#__cm_dl span{font-weight:600}",
    "@media (max-width:640px){#__cm_time{min-width:0}#__cm_time .__cm_tot,#__cm_dl span,#__cm_fs{display:none}}",
    "@media (prefers-reduced-motion:reduce){#__cm_bar *{transition:none!important}}"
  ].join("");
  var ICON = {
    play: '<path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
    pause: '<rect fill="currentColor" x="6.5" y="5" width="4" height="14" rx="1.3"/><rect fill="currentColor" x="13.5" y="5" width="4" height="14" rx="1.3"/>',
    replay: '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></g>',
    back: '<g fill="currentColor"><rect x="5" y="6" width="2.2" height="12" rx="1"/><path d="M18 7v10a.8.8 0 0 1-1.25.66L10 12.66a.8.8 0 0 1 0-1.32l6.75-5A.8.8 0 0 1 18 7z"/></g>',
    fwd: '<g fill="currentColor"><rect x="16.8" y="6" width="2.2" height="12" rx="1"/><path d="M6 7v10a.8.8 0 0 0 1.25.66L14 12.66a.8.8 0 0 0 0-1.32l-6.75-5A.8.8 0 0 0 6 7z"/></g>',
    dl: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/></g>',
    full: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };
  function svg(n) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[n] + "</svg>"; }

  var style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  document.documentElement.classList.add("__cm_on");

  var stage = document.createElement("div"); stage.id = "__cm_stage";
  var scale = document.createElement("div"); scale.id = "__cm_scale";
  scale.style.width = W + "px"; scale.style.height = H + "px";
  root.parentNode.insertBefore(stage, root);
  stage.appendChild(scale);
  scale.appendChild(root);
  // A click on the stage toggles playback; the layer lifts while a comment layer
  // asks to point at the composition itself (html.__cc_pinmode, set by the bar).
  var hit = document.createElement("div"); hit.id = "__cm_hit";
  stage.appendChild(hit);

  var bar = document.createElement("div"); bar.id = "__cm_bar"; bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Motion transport");
  bar.innerHTML =
    '<button id="__cm_pp" aria-label="Play">' + svg("play") + "</button>" +
    '<button id="__cm_back" aria-label="Back one frame">' + svg("back") + "</button>" +
    '<button id="__cm_fwd" aria-label="Forward one frame">' + svg("fwd") + "</button>" +
    '<div id="__cm_time"><b>0:00.0</b><span class="__cm_tot"> / 0:00.0</span></div>' +
    '<div id="__cm_scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0"><div id="__cm_track"><i id="__cm_fill"></i></div><div id="__cm_ticks"></div><div id="__cm_marks"></div><div id="__cm_knob"></div><div id="__cm_tip"></div><div id="__cm_mtip"></div></div>' +
    '<a id="__cm_dl" hidden download>' + svg("dl") + "<span>MP4</span></a>" +
    '<button id="__cm_fs" aria-label="Fullscreen">' + svg("full") + "</button>";
  document.body.appendChild(bar);
  function $(id) { return document.getElementById(id); }
  var scrub = $("__cm_scrub");

  function layout() {
    var top = parseFloat(getComputedStyle(document.documentElement).marginTop) || 0;
    var vw = window.innerWidth, vh = window.innerHeight - top - bar.offsetHeight;
    var gap = vw < 640 ? 0 : 20;
    var s = Math.min((vw - gap * 2) / W, (vh - gap * 2) / H);
    if (!(s > 0)) s = 0.01;
    var w = W * s, h = H * s;
    stage.style.width = w + "px"; stage.style.height = h + "px";
    stage.style.left = Math.round((vw - w) / 2) + "px";
    stage.style.top = Math.round(top + (vh - h) / 2) + "px";
    stage.style.borderRadius = gap ? "6px" : "0";
    scale.style.transform = "scale(" + s + ")";
    // The page behind the stage takes the composition's own ground.
    var bg = getComputedStyle(root).backgroundColor;
    if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = getComputedStyle(document.body).backgroundColor;
    if (!bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent") bg = "#0c0b10";
    stage.style.background = bg;
    marks();
  }
  window.addEventListener("resize", layout);
  // The page bar minimizes by toggling a class on <html>, which moves the top edge.
  new MutationObserver(function () { layout(); hit.hidden = document.documentElement.classList.contains("__cc_pinmode"); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

  // --- state, drawn every frame while playing ---
  var ended = false, dragging = false, lastT = 0, userSeek = false;
  function draw() {
    var t = time(), d = duration();
    var f = d ? clamp(t / d, 0, 1) : 0;
    $("__cm_fill").style.width = f * 100 + "%";
    if (!dragging) $("__cm_knob").style.left = f * 100 + "%";
    $("__cm_time").innerHTML = "<b>" + fmt(t) + '</b><span class="__cm_tot"> / ' + fmt(d) + "</span>";
    scrub.setAttribute("aria-valuenow", t.toFixed(1));
    scrub.setAttribute("aria-valuemax", d.toFixed(1));
    var playing = isPlaying();
    var pp = $("__cm_pp");
    pp.innerHTML = svg(playing ? "pause" : ended ? "replay" : "play");
    pp.setAttribute("aria-label", playing ? "Pause" : ended ? "Replay" : "Play");
  }
  var raf = 0;
  function loop(now) {
    raf = 0;
    if (!hf() && own.playing) { own.t += (now - own.last) / 1000; own.last = now; rawSeek(Math.min(own.t, duration())); }
    var t = time(), d = duration();
    // Stop at the end (loop off); a runtime that wraps reads as having ended too.
    if (isPlaying() && d && (t >= d - 0.5 / FPS || (!userSeek && t + 0.25 < lastT))) {
      rawPause(); rawSeek(d); ended = true;
    }
    userSeek = false;
    lastT = time();
    draw();
    if (isPlaying()) raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(loop); draw(); }

  function seek(t) {
    var d = duration();
    t = clamp(+t || 0, 0, d || 0);
    ended = d > 0 && t >= d - 0.5 / FPS && !isPlaying() ? ended : false;
    userSeek = true;
    rawSeek(t);
    lastT = t;
    kick();
  }
  function play() {
    var d = duration();
    if (ended || (d && time() >= d - 0.5 / FPS)) { ended = false; rawSeek(0); lastT = 0; }
    userSeek = true;
    rawPlay(); kick();
  }
  function pause() { rawPause(); kick(); }
  function toggle() { if (isPlaying()) pause(); else play(); }
  function step(dir) { pause(); seek(Math.round(time() * FPS + dir) / FPS); }

  // --- scrubber: hover tip, drag, beats ---
  function tAt(clientX) { var r = scrub.getBoundingClientRect(); return clamp((clientX - r.left) / r.width, 0, 1) * duration(); }
  scrub.addEventListener("pointermove", function (e) {
    var r = scrub.getBoundingClientRect(), x = clamp(e.clientX - r.left, 0, r.width), tip = $("__cm_tip");
    tip.textContent = fmt(tAt(e.clientX));
    var half = tip.offsetWidth / 2;
    tip.style.left = clamp(x, half, r.width - half) + "px";
  });
  scrub.addEventListener("pointerdown", function (e) {
    if (e.target.closest && e.target.closest(".__cm_mk")) return;
    e.preventDefault();
    scrub.setPointerCapture(e.pointerId);
    var was = isPlaying();
    rawPause();
    dragging = true; bar.setAttribute("data-drag", "");
    var move = function (ev) { var t = tAt(ev.clientX); $("__cm_knob").style.left = (duration() ? t / duration() * 100 : 0) + "%"; seek(t); };
    move(e);
    var up = function () {
      scrub.removeEventListener("pointermove", move); scrub.removeEventListener("pointerup", up); scrub.removeEventListener("pointercancel", up);
      dragging = false; bar.removeAttribute("data-drag");
      if (was) play(); else kick();
    };
    scrub.addEventListener("pointermove", move); scrub.addEventListener("pointerup", up); scrub.addEventListener("pointercancel", up);
  });
  function ticks() {
    var d = duration(), html = "";
    if (!d) return;
    var kids = root.children;
    for (var k = 0; k < kids.length; k++) {
      var s = parseFloat(kids[k].getAttribute("data-start"));
      if (s > 0.05 && s < d - 0.05) html += '<i class="__cm_tick" style="left:' + (s / d * 100) + '%"></i>';
    }
    $("__cm_ticks").innerHTML = html;
  }

  // --- comment markers ---
  var markers = [];
  function marks() {
    var d = duration(), box = $("__cm_marks");
    if (!box) return;
    box.innerHTML = "";
    if (!d) return;
    markers.forEach(function (m) {
      var b = document.createElement("button");
      b.className = "__cm_mk";
      b.style.left = clamp(m.t / d, 0, 1) * 100 + "%";
      b.setAttribute("aria-label", "Comment " + m.n + " at " + fmt(m.t) + (m.label ? ": " + m.label : ""));
      if (m.id) b.setAttribute("data-id", m.id);
      b.innerHTML = m.avatar ? '<img alt="" src="' + esc(m.avatar) + '">' : "<span>" + esc(m.n) + "</span>";
      var tip = $("__cm_mtip");
      b.addEventListener("pointerenter", function () {
        tip.innerHTML = "<i>" + esc(fmt(m.t)) + "</i>" + esc(m.label || "Comment " + m.n);
        var r = scrub.getBoundingClientRect(), x = clamp(m.t / d, 0, 1) * r.width;
        tip.classList.add("__cm_in");
        var half = tip.offsetWidth / 2;
        tip.style.left = clamp(x, half, r.width - half) + "px";
      });
      b.addEventListener("pointerleave", function () { tip.classList.remove("__cm_in"); });
      b.addEventListener("click", function (e) {
        e.stopPropagation(); pause(); seek(m.t);
        window.dispatchEvent(new CustomEvent("cast:marker", { detail: { id: m.id || null, t: m.t, n: m.n } }));
      });
      box.appendChild(b);
    });
  }
  function setMarkers(list) {
    markers = (Array.isArray(list) ? list : []).filter(function (m) { return m && isFinite(m.t); })
      .map(function (m) { return { t: +m.t, n: m.n, label: m.label || "", avatar: m.avatar || null, id: m.id || null }; });
    marks();
  }

  // --- controls ---
  hit.addEventListener("click", toggle);
  $("__cm_pp").addEventListener("click", toggle);
  $("__cm_back").addEventListener("click", function () { step(-1); });
  $("__cm_fwd").addEventListener("click", function () { step(1); });
  $("__cm_fs").addEventListener("click", function () {
    var el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) { var p = el.requestFullscreen(); if (p && p.catch) p.catch(function () {}); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    var el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    if (el && el.tagName === "BUTTON" && e.key === " " && el.closest("#__cm_bar") === null) return;
    var t = time(), used = true;
    switch (e.key) {
      case " ": case "k": toggle(); break;
      case "ArrowRight": seek(t + (e.shiftKey ? 5 : 1)); break;
      case "ArrowLeft": seek(t - (e.shiftKey ? 5 : 1)); break;
      case ".": step(1); break;
      case ",": step(-1); break;
      case "Home": seek(0); break;
      case "End": pause(); seek(duration()); break;
      default:
        if (/^[0-9]$/.test(e.key)) seek(duration() * parseInt(e.key, 10) / 10);
        else used = false;
    }
    if (used) e.preventDefault();
  });

  // --- the last MP4 render, when the directory carries one ---
  function offerRender() {
    if (!document.querySelector("base")) return;
    fetch(new URL("cast-render/motion.json", document.baseURI).href, { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (m) {
        if (!m || !m.mp4) return;
        var name = (document.title || "motion").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "motion";
        var a = $("__cm_dl");
        a.href = new URL(m.mp4, document.baseURI).href + "?download=" + encodeURIComponent(name + ".mp4");
        a.title = "Download MP4" + (m.rendered_at ? " (rendered " + new Date(m.rendered_at).toLocaleString() + ")" : "");
        a.hidden = false;
      })
      .catch(function () {});
  }

  // --- live numbers ---
  function pick(res, col, row) {
    if (!res || !res.rows || !res.rows.length) return null;
    var c = col == null || col === "" ? 0 : /^\d+$/.test(String(col)) ? +col : (res.columns || []).indexOf(String(col));
    if (c < 0) return null;
    var i = row == null || row === "" ? 0 : +row;
    if (i < 0) i = res.rows.length + i;
    var line = res.rows[i];
    return line ? line[c] : null;
  }
  function format(v, how) {
    if (v == null) return null;
    var n = typeof v === "number" ? v : parseFloat(v);
    if (how === "raw" || !isFinite(n)) return String(v);
    if (how === "int") return Math.round(n).toLocaleString();
    if (how === "pct") return (Math.abs(n) <= 1 ? n * 100 : n).toFixed(0) + "%";
    if (how === "usd") return "$" + n.toLocaleString(undefined, { maximumFractionDigits: n < 100 ? 2 : 0 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function value(id, col, row) {
    var c = window.cast;
    if (!c || typeof c.data !== "function") return Promise.resolve(null);
    return Promise.resolve(c.data(id)).then(function (res) { return pick(res, col, row); }, function () { return null; });
  }
  var bound = false;
  function bindData() {
    var c = window.cast;
    if (bound || !c || typeof c.data !== "function") return;
    bound = true;
    var els = document.querySelectorAll("[data-cast-data]"), byId = {};
    for (var k = 0; k < els.length; k++) (byId[els[k].getAttribute("data-cast-data")] = byId[els[k].getAttribute("data-cast-data")] || []).push(els[k]);
    Object.keys(byId).forEach(function (id) {
      var apply = function (res) {
        if (!res) return;
        byId[id].forEach(function (el) {
          var v = format(pick(res, el.getAttribute("data-cast-col"), el.getAttribute("data-cast-row")), el.getAttribute("data-cast-format"));
          if (v != null && !res.error) el.textContent = v;
          if (res.stale || res.error) el.setAttribute("data-cast-stale", ""); else el.removeAttribute("data-cast-stale");
        });
      };
      Promise.resolve(c.data(id)).then(apply, function () {});
      if (typeof c.subscribe === "function") c.subscribe(id, apply);
    });
  }
  window.castMotion = { value: value, bind: bindData };

  // --- the page timeline contract ---
  window.__castTimeline = {
    __source: "motion",
    time: time, duration: duration, seek: function (t) { seek(t); }, play: play, pause: pause,
    playing: isPlaying, setMarkers: setMarkers
  };

  var started = Date.now();
  function ready() {
    // The runtime binds its player a beat after load; the bare timeline carries
    // the page until then (and for good, if the runtime never loads).
    if (!hf() && Date.now() - started < 4000) { setTimeout(ready, 50); return; }
    ticks();
    layout();
    var m = location.hash.match(/(?:^|[#&])t=([\d.]+)/);
    seek(m ? parseFloat(m[1]) : 0);
    bindData();
    offerRender();
    window.dispatchEvent(new Event("cast:timeline-ready"));
  }
  layout();
  draw();
  if (document.readyState === "complete") ready(); else window.addEventListener("load", ready, { once: true });
  window.addEventListener("load", bindData);
}`;

/** The motion player as a script, for pages the server marks as compositions. */
export const CAST_MOTION_JS = "(" + DEFINE_CAST_MOTION + ")();\n";
