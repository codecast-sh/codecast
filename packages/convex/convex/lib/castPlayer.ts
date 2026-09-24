// <cast-player>: the video player published pages get when they use the tag
// (served at /cli/player.js and injected by artifactsHttp.serve). Chapters are
// separate files that play back to back as one film: two <video> elements take
// turns, the idle one loads the next chapter, and they swap on "ended".
//
//   <cast-player poster="poster.jpg" style="--cast-accent:#2aa198">
//     <cast-chapter src="c00.mp4" title="Prologue" duration="120.3"></cast-chapter>
//     <cast-chapter src="c01.mp4" title="Setup"></cast-chapter>
//   </cast-player>
//
// Skin with --cast-accent, --cast-fg, --cast-bg, --cast-panel, --cast-track,
// --cast-radius, --cast-font, --cast-aspect, or ::part(controls | scrubber |
// chapters | play-button). Events: "ready", "chapterchange" ({ index, title }),
// "timeupdate"; properties currentTime, duration, chapters, chapterIndex;
// methods play(), pause(), seek(seconds), goTo(index).
//
// Plain ES5-style string building on purpose: this source sits inside a
// String.raw template, so it must never contain a backtick or a dollar brace.
export const CAST_PLAYER_JS = String.raw`(function () {
  if (window.customElements.get("cast-player")) return;
  var ICON = {
    play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.3"/><rect x="13.5" y="5" width="4" height="14" rx="1.3"/>',
    replay: '<path d="M12 5a7 7 0 1 1-6.6 4.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4.2 4.6v5.2h5.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    prev: '<rect x="5" y="6" width="2.4" height="12" rx="1"/><path d="M19 6.9v10.2a.9.9 0 0 1-1.38.76L9.9 12.76a.9.9 0 0 1 0-1.52l7.72-5.1A.9.9 0 0 1 19 6.9z"/>',
    next: '<rect x="16.6" y="6" width="2.4" height="12" rx="1"/><path d="M5 6.9v10.2a.9.9 0 0 0 1.38.76l7.72-5.1a.9.9 0 0 0 0-1.52L6.38 6.14A.9.9 0 0 0 5 6.9z"/>',
    vol: '<path d="M4 9.5h3.2L11.6 6a.6.6 0 0 1 1 .47v11.06a.6.6 0 0 1-1 .47L7.2 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path d="M15.5 9a4 4 0 0 1 0 6M17.8 6.6a7.4 7.4 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    mute: '<path d="M4 9.5h3.2L11.6 6a.6.6 0 0 1 1 .47v11.06a.6.6 0 0 1-1 .47L7.2 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path d="M16 9.5l5 5M21 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    full: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    exit: '<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    list: '<path d="M4 6.5h1.5M4 12h1.5M4 17.5h1.5M9 6.5h11M9 12h11M9 17.5h11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };
  function svg(name) { return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + ICON[name] + '</svg>'; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(s);
  }
  function parseTime(v) {
    if (!v) return NaN;
    if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
    var parts = v.split(":").map(Number), t = 0;
    for (var i = 0; i < parts.length; i++) t = t * 60 + parts[i];
    return t;
  }
  var CSS = [
    ":host{--accent:var(--cast-accent,#2aa198);--fg:var(--cast-fg,#fff);--bg:var(--cast-bg,#0c0b10);--panel:var(--cast-panel,rgba(18,15,22,.72));--track:var(--cast-track,rgba(255,255,255,.26));--radius:var(--cast-radius,14px);display:block;position:relative;aspect-ratio:var(--cast-aspect,16/9);background:var(--bg);border-radius:var(--radius);overflow:hidden;color:var(--fg);font-family:var(--cast-font,inherit);-webkit-tap-highlight-color:transparent;outline:none;user-select:none;-webkit-user-select:none;isolation:isolate}",
    ":host(:focus-visible){box-shadow:0 0 0 3px var(--accent)}",
    ":host([data-theater]){position:fixed;inset:0;z-index:2147483000;border-radius:0;aspect-ratio:auto}",
    ":host([data-idle]){cursor:none}",
    "video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:var(--bg)}",
    "video.off{visibility:hidden}",
    ".poster{position:absolute;inset:0;background:var(--bg) center/cover no-repeat;transition:opacity .45s ease}",
    ":host([data-started]) .poster{opacity:0;pointer-events:none}",
    ".shade{position:absolute;left:0;right:0;bottom:0;height:34%;background:linear-gradient(to top,rgba(0,0,0,.55),rgba(0,0,0,.16) 60%,rgba(0,0,0,0));pointer-events:none;transition:opacity .4s ease}",
    ".big{position:absolute;left:50%;top:50%;width:92px;height:92px;margin:-46px 0 0 -46px;border-radius:50%;border:0;background:var(--panel);color:var(--fg);display:grid;place-items:center;cursor:pointer;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 12px 44px rgba(0,0,0,.38),inset 0 0 0 1px rgba(255,255,255,.14);transition:transform .3s cubic-bezier(.2,.9,.3,1.35),opacity .3s ease,background .2s ease}",
    ".big:hover{transform:scale(1.07);background:var(--accent)}",
    ".big svg{width:40px;height:40px}",
    ".big.play svg{margin-left:5px}",
    ":host([data-playing]) .big{opacity:0;transform:scale(.8);pointer-events:none}",
    ".bar{position:absolute;left:0;right:0;bottom:0;padding:0 16px 12px;transition:opacity .4s ease,transform .4s ease}",
    ":host([data-idle]) .bar,:host([data-idle]) .shade{opacity:0}",
    ":host([data-idle]) .bar{transform:translateY(8px)}",
    ":host(:not([data-started])) .bar{opacity:0;pointer-events:none}",
    ":host(:not([data-started])) .shade{opacity:.6}",
    ".scrub{position:relative;height:24px;display:flex;align-items:center;gap:3px;cursor:pointer;touch-action:none}",
    ".seg{position:relative;flex:1 1 0;height:4px;border-radius:3px;background:var(--track);overflow:hidden;transition:height .16s ease}",
    ".scrub:hover .seg,:host([data-drag]) .seg{height:6px}",
    ".seg.hot{height:9px!important}",
    ".seg i{position:absolute;left:0;top:0;bottom:0;width:0}",
    ".seg .buf{background:rgba(255,255,255,.3)}",
    ".seg .fill{background:var(--accent)}",
    ".knob{position:absolute;top:50%;left:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:var(--fg);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 50%,transparent),0 2px 8px rgba(0,0,0,.4);transform:scale(0);transition:transform .16s ease;pointer-events:none}",
    ".scrub:hover .knob,:host([data-drag]) .knob{transform:scale(1)}",
    ".tip{position:absolute;bottom:32px;left:0;transform:translateX(-50%);background:var(--panel);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);padding:7px 11px;border-radius:10px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s ease;box-shadow:0 6px 20px rgba(0,0,0,.3)}",
    ".tip b{display:block;font-weight:700;font-size:13px;line-height:1.3}",
    ".tip span{opacity:.75;font-variant-numeric:tabular-nums;font-size:12px}",
    ".scrub:hover .tip,:host([data-drag]) .tip{opacity:1}",
    ".row{display:flex;align-items:center;gap:4px;margin-top:2px}",
    "button{font:inherit}",
    "button.ic{flex:none;width:40px;height:40px;border:0;border-radius:11px;background:transparent;color:var(--fg);display:grid;place-items:center;cursor:pointer;transition:background .15s ease,transform .15s ease}",
    "button.ic:hover{background:rgba(255,255,255,.14)}",
    "button.ic:active{transform:scale(.92)}",
    "button.ic svg{width:22px;height:22px}",
    "button.ic.on{color:var(--accent)}",
    ".time{flex:none;font-size:14px;font-variant-numeric:tabular-nums;opacity:.9;margin:0 8px;white-space:nowrap}",
    ".title{flex:1;min-width:0;font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".title small{font-weight:500;opacity:.68;margin-right:8px;font-size:13px}",
    ".volwrap{display:flex;align-items:center}",
    ".vol{width:0;opacity:0;margin:0;transition:width .2s ease,opacity .2s ease,margin .2s ease;accent-color:var(--accent);cursor:pointer}",
    ".volwrap:hover .vol,.vol:focus{width:84px;opacity:1;margin:0 8px 0 2px}",
    "button.rate{width:auto;padding:0 10px;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}",
    ".menu{position:absolute;right:14px;bottom:78px;width:min(360px,calc(100% - 28px));max-height:calc(100% - 104px);overflow:auto;background:var(--panel);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border-radius:16px;padding:6px;opacity:0;transform:translateY(10px) scale(.98);transform-origin:bottom right;pointer-events:none;transition:opacity .22s ease,transform .22s ease;box-shadow:0 18px 48px rgba(0,0,0,.4),inset 0 0 0 1px rgba(255,255,255,.1)}",
    ":host([data-menu]) .menu{opacity:1;transform:none;pointer-events:auto}",
    ".menu button{display:flex;gap:12px;align-items:baseline;width:100%;text-align:left;border:0;background:transparent;color:var(--fg);font-size:14px;line-height:1.35;padding:9px 11px;border-radius:10px;cursor:pointer}",
    ".menu button:hover{background:rgba(255,255,255,.1)}",
    ".menu button.on{background:color-mix(in srgb,var(--accent) 34%,transparent)}",
    ".menu em{flex:none;font-style:normal;font-variant-numeric:tabular-nums;opacity:.62;font-size:12px;min-width:40px}",
    ".toast{position:absolute;left:20px;top:18px;max-width:calc(100% - 40px);background:var(--panel);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);padding:9px 15px;border-radius:12px;font-size:15px;font-weight:700;opacity:0;transform:translateY(-8px);transition:opacity .4s ease,transform .4s ease;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.3)}",
    ".toast small{display:block;font-weight:500;opacity:.7;font-size:12px;margin-bottom:1px}",
    ".toast.show{opacity:1;transform:none}",
    ".spin{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:3px solid rgba(255,255,255,.22);border-top-color:var(--fg);animation:cast-spin .8s linear infinite;opacity:0;transition:opacity .2s ease;pointer-events:none}",
    ":host([data-wait]) .spin{opacity:1}",
    "@keyframes cast-spin{to{transform:rotate(360deg)}}",
    ".err{position:absolute;inset:0;display:none;place-items:center;text-align:center;padding:24px;font-size:15px;background:var(--bg)}",
    ":host([data-error]) .err{display:grid}",
    "@media (max-width:600px){.title{font-size:13px}.time{font-size:12px;margin:0 4px}.rate,.volwrap,.skip{display:none}.big{width:72px;height:72px;margin:-36px 0 0 -36px}}",
    "@media (prefers-reduced-motion:reduce){*{transition:none!important;animation-duration:2s!important}}"
  ].join("");

  function CastPlayer() { return Reflect.construct(HTMLElement, [], CastPlayer); }
  CastPlayer.prototype = Object.create(HTMLElement.prototype);
  CastPlayer.prototype.constructor = CastPlayer;
  Object.setPrototypeOf(CastPlayer, HTMLElement);

  var P = CastPlayer.prototype;

  P.connectedCallback = function () {
    if (this._built) return;
    this._built = true;
    var self = this;
    // Children are parsed after the element opens; wait a tick so <cast-chapter>s exist.
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { self._build(); }, { once: true });
    else setTimeout(function () { self._build(); }, 0);
  };

  P._build = function () {
    var self = this;
    var ch = Array.prototype.map.call(this.querySelectorAll("cast-chapter"), function (el) {
      return { src: el.getAttribute("src"), title: el.getAttribute("title") || "", duration: parseFloat(el.getAttribute("duration")) || 0 };
    });
    if (!ch.length && this.getAttribute("src")) ch = [{ src: this.getAttribute("src"), title: this.getAttribute("title") || "", duration: 0 }];
    this.ch = ch;
    this.i = 0;
    this.rate = 1;
    if (!this.hasAttribute("tabindex")) this.tabIndex = 0;
    this.setAttribute("role", "region");
    this.setAttribute("aria-label", this.getAttribute("title") || "Video");

    var root = this.shadowRoot || this.attachShadow({ mode: "open" });
    var segs = ch.map(function (c, k) { return '<div class="seg" data-k="' + k + '"><i class="buf"></i><i class="fill"></i></div>'; }).join("");
    var multi = ch.length > 1;
    root.innerHTML = "<style>" + CSS + "</style>" +
      '<video class="va" playsinline preload="metadata"></video>' +
      '<video class="vb off" playsinline preload="auto"></video>' +
      '<div class="poster"></div><div class="shade"></div><div class="spin"></div>' +
      '<div class="toast" aria-live="polite"></div>' +
      '<button class="big play" part="play-button" aria-label="Play">' + svg("play") + "</button>" +
      '<div class="menu" part="chapters" role="menu"></div>' +
      '<div class="err">This video could not be loaded.</div>' +
      '<div class="bar" part="controls">' +
        '<div class="scrub" part="scrubber" role="slider" aria-label="Seek" tabindex="-1">' + segs + '<div class="knob"></div><div class="tip"><b></b><span></span></div></div>' +
        '<div class="row">' +
          '<button class="ic pp" aria-label="Play">' + svg("play") + "</button>" +
          (multi ? '<button class="ic skip prev" aria-label="Previous chapter">' + svg("prev") + '</button><button class="ic skip next" aria-label="Next chapter">' + svg("next") + "</button>" : "") +
          '<div class="volwrap"><button class="ic mute" aria-label="Mute">' + svg("vol") + '</button><input class="vol" type="range" min="0" max="1" step="0.02" value="1" aria-label="Volume"></div>' +
          '<div class="time">0:00 / 0:00</div>' +
          '<div class="title"></div>' +
          '<button class="ic rate" aria-label="Playback speed">1x</button>' +
          (multi ? '<button class="ic list" aria-label="Chapters">' + svg("list") + "</button>" : "") +
          '<button class="ic fs" aria-label="Fullscreen">' + svg("full") + "</button>" +
        "</div>" +
      "</div>";
    var $ = function (s) { return root.querySelector(s); };
    this.$ = $;
    this.v = $(".va");
    this.w = $(".vb");
    this.segs = Array.prototype.slice.call(root.querySelectorAll(".seg"));
    var poster = this.getAttribute("poster");
    if (poster) $(".poster").style.backgroundImage = "url(" + JSON.stringify(new URL(poster, document.baseURI).href) + ")";

    [this.v, this.w].forEach(function (vid) {
      vid.addEventListener("timeupdate", function (e) { if (e.target === self.v) self._sync(); });
      vid.addEventListener("progress", function (e) { if (e.target === self.v) self._sync(); });
      vid.addEventListener("ended", function (e) { if (e.target === self.v) self._ended(); });
      vid.addEventListener("waiting", function (e) { if (e.target === self.v) self.setAttribute("data-wait", ""); });
      ["playing", "canplay", "seeked"].forEach(function (ev) { vid.addEventListener(ev, function (e) { if (e.target === self.v) self.removeAttribute("data-wait"); }); });
      vid.addEventListener("play", function (e) { if (e.target === self.v) self._state(); });
      vid.addEventListener("pause", function (e) { if (e.target === self.v) self._state(); });
      vid.addEventListener("error", function (e) { if (e.target === self.v && self.v.getAttribute("src")) self.setAttribute("data-error", ""); });
    });

    $(".big").addEventListener("click", function () { self.toggle(); });
    $(".pp").addEventListener("click", function () { self.toggle(); });
    this.v.addEventListener("click", function () { self.toggle(); });
    this.w.addEventListener("click", function () { self.toggle(); });
    if (multi) {
      $(".prev").addEventListener("click", function () { self.prevChapter(); });
      $(".next").addEventListener("click", function () { self.goTo(self.i + 1); });
      $(".list").addEventListener("click", function (e) { e.stopPropagation(); self._menu(!self.hasAttribute("data-menu")); });
    }
    $(".mute").addEventListener("click", function () { self._setMuted(!self.v.muted); });
    $(".vol").addEventListener("input", function (e) { self._setVolume(parseFloat(e.target.value)); });
    $(".rate").addEventListener("click", function () {
      var rates = [1, 1.25, 1.5, 1.75, 2, 0.75];
      self.rate = rates[(rates.indexOf(self.rate) + 1) % rates.length];
      self.v.playbackRate = self.w.playbackRate = self.rate;
      $(".rate").textContent = self.rate + "x";
    });
    $(".fs").addEventListener("click", function () { self.toggleFullscreen(); });
    document.addEventListener("fullscreenchange", function () { self._fsIcon(); });
    document.addEventListener("webkitfullscreenchange", function () { self._fsIcon(); });
    root.addEventListener("click", function (e) { if (self.hasAttribute("data-menu") && !e.composedPath().some(function (n) { return n.classList && n.classList.contains("menu"); })) self._menu(false); });

    this._bindScrub();
    this._bindIdle();
    this._bindKeys();
    this._renderMenu();
    this._layout();
    this._probe();

    // Deep links: #t=1:30 (film time) or #chapter=3 (1-based).
    var hash = location.hash.slice(1), m;
    var start = 0;
    if ((m = hash.match(/(?:^|&)t=([\d:.]+)/))) start = parseTime(m[1]) || 0;
    if ((m = hash.match(/(?:^|&)chapter=(\d+)/))) this._pendingChapter = Math.max(0, Math.min(ch.length - 1, parseInt(m[1], 10) - 1));
    this._load(0, 0, false);
    if (this._pendingChapter || start) this._pendingSeek = start;
    this._sync();
    this._title();
    this.dispatchEvent(new Event("ready"));
  };

  // --- chapters and timing ---
  P._starts = function () { var t = 0; return (this.ch || []).map(function (c) { var s = t; t += c.duration || 0; return s; }); };
  Object.defineProperty(P, "duration", { get: function () { return (this.ch || []).reduce(function (a, c) { return a + (c.duration || 0); }, 0); } });
  Object.defineProperty(P, "chapters", { get: function () { var st = this._starts(); return (this.ch || []).map(function (c, k) { return { title: c.title, src: c.src, start: st[k], duration: c.duration }; }); } });
  Object.defineProperty(P, "chapterIndex", { get: function () { return this.i; } });
  Object.defineProperty(P, "currentTime", {
    get: function () { return (this._starts()[this.i] || 0) + (this.v.currentTime || 0); },
    set: function (t) { this.seek(t); }
  });
  Object.defineProperty(P, "paused", { get: function () { return this.v.paused; } });

  // Lengths come from the chapter attributes when given, else from each file's
  // metadata, all fetched at once (a few kilobytes each for a faststart mp4).
  P._probe = function () {
    var self = this, left = 0;
    var settle = function () {
      self._layout(); self._sync();
      if (left > 0) return;
      if (self._pendingSeek !== undefined || self._pendingChapter !== undefined) {
        var t = self._pendingChapter !== undefined ? self._starts()[self._pendingChapter] : self._pendingSeek;
        self._pendingSeek = self._pendingChapter = undefined;
        if (t) self.seek(t, false);
      }
      self.dispatchEvent(new Event("durationchange"));
    };
    this.ch.forEach(function (c) {
      if (c.duration) return;
      left++;
      var probe = document.createElement("video");
      probe.preload = "metadata";
      var done = function () {
        if (isFinite(probe.duration)) c.duration = probe.duration;
        probe.removeAttribute("src"); probe.load();
        left--; settle();
      };
      probe.addEventListener("loadedmetadata", done, { once: true });
      probe.addEventListener("error", done, { once: true });
      probe.src = c.src;
    });
    if (!left) settle();
  };

  P._layout = function () {
    var self = this, known = this.ch.every(function (c) { return c.duration; });
    this.segs.forEach(function (s, k) { s.style.flexGrow = known ? String(self.ch[k].duration) : "1"; });
    this._renderMenu();
  };

  P._load = function (k, t, play) {
    var self = this, c = this.ch[k];
    if (!c) return;
    var changed = k !== this.i;
    if (this.w.dataset.k === String(k) && this.w.getAttribute("src")) {
      var old = this.v; this.v = this.w; this.w = old;
      this.v.classList.remove("off"); this.w.classList.add("off");
      this.w.pause();
    } else if (this.v.dataset.k !== String(k)) {
      this.v.src = c.src; this.v.dataset.k = String(k);
    }
    this.i = k;
    this.v.playbackRate = this.rate;
    this.w.muted = this.v.muted; this.w.volume = this.v.volume;
    var go = function () {
      if (t || self.v.currentTime) { try { self.v.currentTime = t || 0; } catch (e) {} }
      if (play) { var p = self.v.play(); if (p && p.catch) p.catch(function () {}); }
    };
    if (this.v.readyState >= 1) go(); else this.v.addEventListener("loadedmetadata", go, { once: true });
    // The idle element loads the next chapter so the handoff is instant.
    var n = this.ch[k + 1];
    if (n && this.w.dataset.k !== String(k + 1)) { this.w.src = n.src; this.w.dataset.k = String(k + 1); this.w.preload = "auto"; }
    if (changed) {
      this._title();
      this._renderMenu();
      this.dispatchEvent(new CustomEvent("chapterchange", { detail: { index: k, title: c.title } }));
      if (this.hasAttribute("data-started")) this._toast();
      this._media();
    }
    this._sync();
  };

  P._ended = function () {
    if (this.i + 1 < this.ch.length) { this._load(this.i + 1, 0, true); return; }
    this.setAttribute("data-ended", "");
    this._state();
  };

  // --- transport ---
  P.play = function () {
    this.setAttribute("data-started", "");
    if (this.hasAttribute("data-ended")) { this.removeAttribute("data-ended"); this._load(0, 0, true); return; }
    var p = this.v.play(); if (p && p.catch) p.catch(function () {});
  };
  P.pause = function () { this.v.pause(); };
  P.toggle = function () { if (this.v.paused) this.play(); else this.pause(); };
  P.seek = function (t, play) {
    var st = this._starts(), k = 0;
    t = Math.max(0, Math.min(t, this.duration - 0.05));
    for (var j = 0; j < st.length; j++) if (t >= st[j]) k = j;
    this.removeAttribute("data-ended");
    var playing = play === undefined ? !this.v.paused : play;
    if (k === this.i) { try { this.v.currentTime = t - st[k]; } catch (e) {} this._sync(); }
    else this._load(k, t - st[k], playing);
  };
  P.goTo = function (k) {
    if (k < 0 || k >= this.ch.length) return;
    this.setAttribute("data-started", "");
    this._load(k, 0, true);
  };
  P.prevChapter = function () { if (this.v.currentTime > 3 || this.i === 0) this.seek(this._starts()[this.i]); else this.goTo(this.i - 1); };
  P._setMuted = function (m) { this.v.muted = this.w.muted = m; this._state(); };
  P._setVolume = function (x) { this.v.volume = this.w.volume = x; this._setMuted(x === 0); };

  P.toggleFullscreen = function () {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (this.hasAttribute("data-theater")) { this.removeAttribute("data-theater"); this._fsIcon(); return; }
    var req = this.requestFullscreen || this.webkitRequestFullscreen;
    var enabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    var self = this;
    // A frame without allow="fullscreen" refuses; fill the frame instead.
    var theater = function () { self.setAttribute("data-theater", ""); self._fsIcon(); };
    if (!req || !enabled) { theater(); return; }
    try { var p = req.call(this); if (p && p.catch) p.catch(theater); } catch (e) { theater(); }
  };
  P._fsIcon = function () {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement) || this.hasAttribute("data-theater");
    this.$(".fs").innerHTML = svg(on ? "exit" : "full");
    this.$(".fs").setAttribute("aria-label", on ? "Exit fullscreen" : "Fullscreen");
  };

  // --- UI sync ---
  P._state = function () {
    var playing = !this.v.paused && !this.v.ended;
    if (playing) { this.setAttribute("data-playing", ""); this.setAttribute("data-started", ""); } else this.removeAttribute("data-playing");
    var ended = this.hasAttribute("data-ended");
    this.$(".pp").innerHTML = svg(playing ? "pause" : ended ? "replay" : "play");
    this.$(".pp").setAttribute("aria-label", playing ? "Pause" : "Play");
    var big = this.$(".big");
    big.innerHTML = svg(ended ? "replay" : "play");
    big.className = "big" + (ended ? "" : " play");
    this.$(".mute").innerHTML = svg(this.v.muted ? "mute" : "vol");
    this.$(".vol").value = this.v.muted ? 0 : this.v.volume;
    if (playing) this._tick(); else this._idle(false);
    this.dispatchEvent(new Event(playing ? "play" : "pause"));
  };
  P._tick = function () {
    var self = this;
    if (this._raf) return;
    var loop = function () { self._sync(); self._raf = !self.v.paused ? requestAnimationFrame(loop) : 0; };
    this._raf = requestAnimationFrame(loop);
  };
  P._sync = function () {
    var st = this._starts(), total = this.duration, i = this.i, v = this.v;
    var now = (st[i] || 0) + (v.currentTime || 0);
    this.segs.forEach(function (s, k) {
      var fill = k < i ? 1 : k > i ? 0 : (v.duration ? v.currentTime / v.duration : 0);
      s.children[1].style.width = (fill * 100) + "%";
      var buf = k < i ? 1 : 0;
      if (k === i && v.buffered && v.buffered.length && v.duration) buf = v.buffered.end(v.buffered.length - 1) / v.duration;
      s.children[0].style.width = (Math.min(1, buf) * 100) + "%";
    });
    var seg = this.segs[i];
    if (seg && !this.hasAttribute("data-drag")) {
      var scrub = this.$(".scrub").getBoundingClientRect(), r = seg.getBoundingClientRect();
      var f = v.duration ? v.currentTime / v.duration : 0;
      this.$(".knob").style.left = (r.left - scrub.left + f * r.width) + "px";
    }
    this.$(".time").textContent = fmt(now) + " / " + fmt(total);
    this.$(".scrub").setAttribute("aria-valuenow", String(Math.round(now)));
    this.$(".scrub").setAttribute("aria-valuemax", String(Math.round(total)));
    this.dispatchEvent(new Event("timeupdate"));
  };
  P._title = function () {
    var c = this.ch[this.i] || {}, multi = this.ch.length > 1;
    this.$(".title").innerHTML = (multi ? "<small>" + (this.i + 1) + " / " + this.ch.length + "</small>" : "") + esc(c.title || this.getAttribute("title") || "");
  };
  P._toast = function () {
    var t = this.$(".toast"), c = this.ch[this.i], self = this;
    if (!c || !c.title) return;
    t.innerHTML = "<small>Chapter " + (this.i + 1) + " of " + this.ch.length + "</small>" + esc(c.title);
    t.classList.add("show");
    clearTimeout(this._toastT);
    this._toastT = setTimeout(function () { t.classList.remove("show"); }, 2600);
  };
  P._renderMenu = function () {
    var self = this, menu = this.$ && this.$(".menu");
    if (!menu) return;
    var st = this._starts(), known = this.ch.every(function (c) { return c.duration; });
    menu.innerHTML = this.ch.map(function (c, k) {
      return '<button role="menuitem" data-k="' + k + '" class="' + (k === self.i ? "on" : "") + '"><em>' + (known ? fmt(st[k]) : k + 1) + "</em><span>" + esc(c.title || "Chapter " + (k + 1)) + "</span></button>";
    }).join("");
    Array.prototype.forEach.call(menu.querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () { self._menu(false); self.goTo(parseInt(b.getAttribute("data-k"), 10)); });
    });
  };
  P._menu = function (open) {
    if (open) this.setAttribute("data-menu", ""); else this.removeAttribute("data-menu");
    var l = this.$(".list"); if (l) l.classList.toggle("on", !!open);
    this._idle(false);
  };
  P._media = function () {
    if (!("mediaSession" in navigator)) return;
    var self = this, c = this.ch[this.i] || {};
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: c.title || document.title, album: this.getAttribute("title") || document.title });
      navigator.mediaSession.setActionHandler("nexttrack", this.i + 1 < this.ch.length ? function () { self.goTo(self.i + 1); } : null);
      navigator.mediaSession.setActionHandler("previoustrack", function () { self.prevChapter(); });
    } catch (e) {}
  };

  // --- scrubber: one timeline over every chapter ---
  P._timeAt = function (clientX) {
    var segs = this.segs, st = this._starts();
    for (var k = 0; k < segs.length; k++) {
      var r = segs[k].getBoundingClientRect();
      var last = k === segs.length - 1;
      if (clientX <= r.right + 1.5 || last) {
        var f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        return { k: k, t: st[k] + f * (this.ch[k].duration || 0), x: Math.max(r.left, Math.min(r.right, clientX)) };
      }
    }
    return { k: 0, t: 0, x: clientX };
  };
  P._bindScrub = function () {
    var self = this, scrub = this.$(".scrub"), tip = this.$(".tip");
    var hover = function (e) {
      var at = self._timeAt(e.clientX), box = scrub.getBoundingClientRect();
      var half = tip.offsetWidth / 2, x = at.x - box.left;
      tip.style.left = Math.max(half, Math.min(box.width - half, x)) + "px";
      tip.children[0].textContent = self.ch[at.k].title || "";
      tip.children[0].style.display = self.ch[at.k].title ? "" : "none";
      tip.children[1].textContent = fmt(at.t);
      self.segs.forEach(function (s, k) { s.classList.toggle("hot", k === at.k); });
      return at;
    };
    scrub.addEventListener("pointermove", hover);
    scrub.addEventListener("pointerleave", function () { self.segs.forEach(function (s) { s.classList.remove("hot"); }); });
    scrub.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      scrub.setPointerCapture(e.pointerId);
      self.setAttribute("data-drag", "");
      self.setAttribute("data-started", "");
      var wasPlaying = !self.v.paused, last = hover(e);
      var move = function (ev) { last = hover(ev); self.$(".knob").style.left = (last.x - scrub.getBoundingClientRect().left) + "px"; };
      move(e);
      var up = function () {
        scrub.removeEventListener("pointermove", move);
        scrub.removeEventListener("pointerup", up);
        scrub.removeEventListener("pointercancel", up);
        self.removeAttribute("data-drag");
        self.seek(last.t, wasPlaying);
      };
      scrub.addEventListener("pointermove", move);
      scrub.addEventListener("pointerup", up);
      scrub.addEventListener("pointercancel", up);
    });
  };

  // --- controls fade away while watching ---
  P._bindIdle = function () {
    var self = this;
    var wake = function () { self._idle(false); };
    this.addEventListener("pointermove", wake);
    this.addEventListener("pointerdown", wake);
    this.addEventListener("focusin", wake);
    this.addEventListener("pointerleave", function () { if (!self.v.paused) self._idle(true); });
  };
  P._idle = function (now) {
    var self = this;
    clearTimeout(this._idleT);
    if (now) { if (!this.hasAttribute("data-menu") && !this.hasAttribute("data-drag")) this.setAttribute("data-idle", ""); return; }
    this.removeAttribute("data-idle");
    if (!this.v.paused) this._idleT = setTimeout(function () { self._idle(true); }, 2600);
  };

  P._bindKeys = function () {
    var self = this;
    this.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = self.currentTime, used = true;
      switch (e.key) {
        case " ": case "k": self.toggle(); break;
        case "ArrowRight": self.seek(t + 5); break;
        case "ArrowLeft": self.seek(t - 5); break;
        case "l": self.seek(t + 10); break;
        case "j": self.seek(t - 10); break;
        case "]": case "n": self.goTo(self.i + 1); break;
        case "[": case "p": self.prevChapter(); break;
        case "f": self.toggleFullscreen(); break;
        case "m": self._setMuted(!self.v.muted); break;
        case "Escape": if (self.hasAttribute("data-menu")) self._menu(false); else if (self.hasAttribute("data-theater")) self.toggleFullscreen(); else used = false; break;
        default:
          if (/^[0-9]$/.test(e.key)) self.seek(self.duration * parseInt(e.key, 10) / 10);
          else used = false;
      }
      if (used) { e.preventDefault(); self._idle(false); }
    });
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  window.customElements.define("cast-player", CastPlayer);
  if (!window.customElements.get("cast-chapter")) window.customElements.define("cast-chapter", (function () {
    function C() { return Reflect.construct(HTMLElement, [], C); }
    C.prototype = Object.create(HTMLElement.prototype); C.prototype.constructor = C; Object.setPrototypeOf(C, HTMLElement);
    return C;
  })());
})();
`;
