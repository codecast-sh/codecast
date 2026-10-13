// The decision page kit's script (docs/line/decision-kit/README.md). It draws
// what plain CSS cannot: a message's sender line, the folds, and a diff read
// from the text git printed. Everything it touches is readable without it.
(function () {
  if (window.__decisionKit) return;
  window.__decisionKit = true;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many || one + "s"); }

  // ── Messages ──────────────────────────────────────────────────────────────
  function trimEdges(box) {
    var first = box.firstChild, last = box.lastChild;
    if (first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^\s+/, "");
    if (last && last.nodeType === 3) last.nodeValue = last.nodeValue.replace(/\s+$/, "");
  }

  // Union writes its messages in markdown and the person saw them rendered, so
  // **bold** and [text](link) in a pasted message draw as they arrived.
  function renderEmphasis(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [], n;
    var MD = /\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
    while ((n = walker.nextNode())) { MD.lastIndex = 0; if (MD.test(n.nodeValue)) nodes.push(n); }
    nodes.forEach(function (node) {
      var text = node.nodeValue, frag = document.createDocumentFragment(), at = 0, m;
      MD.lastIndex = 0;
      while ((m = MD.exec(text))) {
        frag.appendChild(document.createTextNode(text.slice(at, m.index)));
        if (m[1] != null) frag.appendChild(el("strong", null, m[1]));
        else { var a = el("a", null, m[2]); a.href = m[3]; a.target = "_blank"; a.rel = "noreferrer"; frag.appendChild(a); }
        at = MD.lastIndex;
      }
      frag.appendChild(document.createTextNode(text.slice(at)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  function drawMessage(m) {
    if (m.hasAttribute("data-dk")) return;
    var body = el("div", "dk-body");
    while (m.firstChild) body.appendChild(m.firstChild);
    trimEdges(body);
    renderEmphasis(body);

    var meta = el("div", "dk-meta");
    if (m.getAttribute("from")) meta.appendChild(el("b", null, m.getAttribute("from")));
    if (m.getAttribute("channel")) meta.appendChild(el("span", null, m.getAttribute("channel")));
    if (m.getAttribute("time")) meta.appendChild(el("span", "dk-time", m.getAttribute("time")));
    if (meta.firstChild) m.appendChild(meta);

    var bubble = el("div", "dk-bubble");
    if (m.getAttribute("subject")) bubble.appendChild(el("div", "dk-subject", m.getAttribute("subject")));
    bubble.appendChild(body);
    m.appendChild(bubble);
    if (m.getAttribute("note")) m.appendChild(el("div", "dk-note", m.getAttribute("note")));
    m.setAttribute("data-dk", "");

    // A long message folds; the one the page is about never does. Length is
    // judged by the text, not the rendered height, so a short email in a narrow
    // column stays whole.
    if (m.hasAttribute("miss") || m.hasAttribute("full")) return;
    var text = body.textContent.trim();
    if (text.length > 1100 || text.split("\n").length > 18) {
      body.setAttribute("data-clamped", "");
      var more = el("button", "dk-more", "Show the whole message");
      more.type = "button";
      more.addEventListener("click", function () { body.removeAttribute("data-clamped"); more.remove(); });
      bubble.appendChild(more);
    }
  }

  function drawThread(t) {
    if (t.hasAttribute("data-dk")) return;
    var items = [].filter.call(t.children, function (c) { return /^DK-(MSG|EVENT)$/.test(c.tagName); });
    if (t.getAttribute("who")) {
      var who = el("div", "dk-who");
      who.appendChild(el("b", null, t.getAttribute("who")));
      if (t.getAttribute("role")) who.appendChild(el("span", null, t.getAttribute("role")));
      t.insertBefore(who, t.firstChild);
    }
    t.setAttribute("data-dk", "");
    var show = parseInt(t.getAttribute("show") || "", 10);
    if (!(show > 0)) show = items.length <= 6 ? items.length : 4;
    // The miss and everything after it always show.
    var miss = items.findIndex(function (c) { return c.hasAttribute("miss"); });
    var from = Math.max(0, items.length - show);
    if (miss >= 0) from = Math.min(from, miss);
    var earlier = items.slice(0, from);
    if (!earlier.length) return;
    earlier.forEach(function (c) { c.hidden = true; });
    var count = earlier.filter(function (c) { return c.tagName === "DK-MSG"; }).length;
    var more = el("button", "dk-more", count ? "Show " + plural(count, "earlier message") : "Show what came before");
    more.type = "button";
    more.addEventListener("click", function () { earlier.forEach(function (c) { c.hidden = false; }); more.remove(); });
    t.insertBefore(more, items[0]);
  }

  // ── Cases ─────────────────────────────────────────────────────────────────
  // A case is what we say about it and what it shows; the two halves sit side
  // by side or stacked, as the room allows.
  function drawExamples(group) {
    if (group.hasAttribute("data-dk")) return;
    var cases = el("div", "dk-cases");
    while (group.firstChild) cases.appendChild(group.firstChild);
    group.appendChild(cases);
    [].forEach.call(cases.querySelectorAll(":scope > dk-example"), function (ex) {
      var says = el("div", "dk-says"), shows = el("div", "dk-shows");
      [].slice.call(ex.children).forEach(function (c) {
        (/^DK-(MSG|PAIR|GAP|VIEW|THREAD|DIFF)$/.test(c.tagName) ? shows : says).appendChild(c);
      });
      ex.textContent = "";
      ex.appendChild(says);
      if (shows.firstChild) ex.appendChild(shows);
      ex.setAttribute("data-dk", "");
    });
    group.setAttribute("data-dk", "");
  }

  // ── Diffs ─────────────────────────────────────────────────────────────────
  var PROSE_EXT = /\.(md|mdx|markdown|txt|njk|j2|jinja|hbs|mustache|liquid|prompt|tmpl|rst)$/i;

  function parseUnified(text) {
    var files = [], file = null, hunk = null, lines = text.replace(/\r\n/g, "\n").split("\n");
    function open(name) { file = { name: name || "", hunks: [], added: 0, removed: 0 }; files.push(file); hunk = null; }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
        var c = l.charAt(0);
        if (c === "\\") continue;
        if (c === "+") { hunk.rows.push({ t: "+", s: l.slice(1) }); hunk.newLeft--; file.added++; continue; }
        if (c === "-") { hunk.rows.push({ t: "-", s: l.slice(1) }); hunk.oldLeft--; file.removed++; continue; }
        hunk.rows.push({ t: " ", s: l.slice(1) }); hunk.oldLeft--; hunk.newLeft--; continue;
      }
      var m;
      if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l))) { open(m[2]); continue; }
      if ((m = /^\+\+\+ (?:b\/)?(.+)$/.exec(l))) { if (!file || file.hunks.length) open(""); if (m[1] !== "/dev/null") file.name = m[1].trim(); continue; }
      if ((m = /^--- (?:a\/)?(.+)$/.exec(l))) { if (!file || file.hunks.length) open(""); if (m[1] !== "/dev/null" && !file.name) file.name = m[1].trim(); continue; }
      if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(l))) {
        if (!file) open("");
        hunk = { oldStart: +m[1], newStart: +m[3], oldLeft: m[2] == null ? 1 : +m[2], newLeft: m[4] == null ? 1 : +m[4], context: m[5] || "", rows: [] };
        file.hunks.push(hunk);
      }
    }
    return files.filter(function (f) { return f.hunks.length; });
  }

  function tokens(s) { return s.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || []; }

  // Word-level difference of two texts as [{t: "=" | "-" | "+", s}], or null when they are too long to compare.
  function wordDiff(a, b) {
    var A = tokens(a), B = tokens(b), n = A.length, m = B.length;
    if (n * m > 6e6) return null;
    var w = m + 1, L = new Uint32Array((n + 1) * w), i, j;
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
    var ops = [];
    function push(t, s) { var last = ops[ops.length - 1]; if (last && last.t === t) last.s += s; else ops.push({ t: t, s: s }); }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { push("=", A[i]); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) push("-", A[i++]);
      else push("+", B[j++]);
    }
    while (i < n) push("-", A[i++]);
    while (j < m) push("+", B[j++]);
    return ops;
  }

  // Group into runs of unchanged text and changes, then fold a few stray shared
  // words between two changes into one change: "the" matching "the" is not news.
  function segments(ops) {
    var segs = [], cur = null;
    ops.forEach(function (o) {
      if (o.t === "=") { segs.push({ eq: o.s }); cur = null; return; }
      if (!cur) { cur = { del: "", ins: "" }; segs.push(cur); }
      if (o.t === "-") cur.del += o.s; else cur.ins += o.s;
    });
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i], prev = out[out.length - 1], next = segs[i + 1];
      var small = s.eq != null && s.eq.length < 28 && (s.eq.match(/[A-Za-z0-9_]+/g) || []).length < 4;
      if (small && prev && prev.eq == null && next && next.eq == null) {
        prev.del += s.eq + next.del; prev.ins += s.eq + next.ins; i++;
      } else out.push(s.eq != null ? { eq: s.eq } : { del: s.del, ins: s.ins });
    }
    return out;
  }
  function similarity(segs, a, b) {
    var same = 0;
    segs.forEach(function (s) { if (s.eq != null) same += s.eq.length; });
    return same / Math.max(1, Math.max(a.length, b.length));
  }

  // A long unchanged stretch keeps its ends and folds the middle behind a button.
  function appendUnchanged(parent, text, position) {
    var KEEP = 110, MIN = 320;
    if (text.length < MIN) { parent.appendChild(document.createTextNode(text)); return; }
    var head = position === "first" ? "" : text.slice(0, text.indexOf(" ", KEEP) + 1 || KEEP);
    var tailAt = position === "last" ? text.length : Math.max(head.length, text.lastIndexOf(" ", text.length - KEEP));
    var mid = text.slice(head.length, tailAt), tail = text.slice(tailAt);
    if (mid.length < 120) { parent.appendChild(document.createTextNode(text)); return; }
    if (head) parent.appendChild(document.createTextNode(head));
    var words = (mid.match(/\S+/g) || []).length;
    var skip = el("button", "dk-skip", "…");
    skip.type = "button";
    skip.title = "Show " + plural(words, "unchanged word");
    skip.addEventListener("click", function () { skip.replaceWith(document.createTextNode(mid)); });
    parent.appendChild(skip);
    if (tail) parent.appendChild(document.createTextNode(tail));
  }

  function inline(parent, segs, fold) {
    segs.forEach(function (s, i) {
      if (s.eq != null) {
        if (fold) appendUnchanged(parent, s.eq, i === 0 ? "first" : i === segs.length - 1 ? "last" : "mid");
        else parent.appendChild(document.createTextNode(s.eq));
        return;
      }
      if (s.del) parent.appendChild(/\S/.test(s.del) ? el("del", null, s.del) : document.createTextNode(""));
      if (s.ins) parent.appendChild(/\S/.test(s.ins) ? el("ins", null, s.ins) : document.createTextNode(s.ins));
    });
  }

  // A hunk as runs: unchanged lines, and changes (the lines removed, the lines added).
  function runs(hunk) {
    var out = [], oldNo = hunk.oldStart, newNo = hunk.newStart, cur = null;
    hunk.rows.forEach(function (r) {
      if (r.t === " ") {
        if (!cur || cur.kind !== "same") { cur = { kind: "same", rows: [] }; out.push(cur); }
        cur.rows.push({ s: r.s, oldNo: oldNo++, newNo: newNo++ });
        return;
      }
      if (!cur || cur.kind !== "change") { cur = { kind: "change", del: [], ins: [], oldNo: oldNo, newNo: newNo }; out.push(cur); }
      if (r.t === "-") cur.del.push({ s: r.s, no: oldNo++ }); else cur.ins.push({ s: r.s, no: newNo++ });
    });
    return out;
  }

  function proseBlock(cls, tag, text) {
    var p = el("p", "dk-prose " + cls);
    p.appendChild(el("span", "dk-tag", tag));
    p.appendChild(document.createTextNode(text));
    return p;
  }

  // Template tags in a prompt ({% if %}, {{ }}) are set apart from its words.
  function dimTemplate(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [], n;
    while ((n = walker.nextNode())) if (/\{[%{#]|[%}#]\}/.test(n.nodeValue)) nodes.push(n);
    nodes.forEach(function (node) {
      var parts = node.nodeValue.split(/(\{%[\s\S]*?%\}|\{#[\s\S]*?#\}|\{\{-?|-?\}\})/), frag = document.createDocumentFragment();
      parts.forEach(function (part, i) {
        if (!part) return;
        frag.appendChild(i % 2 ? el("span", "dk-tpl", part) : document.createTextNode(part));
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

  function drawProse(box, file) {
    file.hunks.forEach(function (hunk) {
      runs(hunk).forEach(function (run) {
        if (run.kind !== "change") return;
        var a = run.del.map(function (r) { return r.s; }).join("\n"), b = run.ins.map(function (r) { return r.s; }).join("\n");
        var change = el("div", "dk-change");
        if (!a.trim()) change.appendChild(proseBlock("dk-now", "Added", b));
        else if (!b.trim()) change.appendChild(proseBlock("dk-was", "Removed", a));
        else {
          var ops = wordDiff(a, b), segs = ops && segments(ops);
          if (!segs || similarity(segs, a, b) < 0.3) {
            change.appendChild(proseBlock("dk-was", "Was", a));
            change.appendChild(proseBlock("dk-now", "Now", b));
          } else {
            var p = el("p", "dk-prose");
            inline(p, segs, true);
            change.appendChild(p);
          }
        }
        dimTemplate(change);
        box.appendChild(change);
      });
    });
  }

  function codeRow(cls, no, sign, fill) {
    var row = el("div", "dk-row" + (cls ? " " + cls : ""));
    row.appendChild(el("span", "dk-ln", no == null ? "" : String(no)));
    row.appendChild(el("span", "dk-sign", sign));
    var code = el("span", "dk-text");
    if (typeof fill === "string") code.textContent = fill || " "; else fill(code);
    row.appendChild(code);
    return row;
  }

  // Rows past the first `head` and before the last `tail` wait behind one button.
  function foldRows(box, rows, head, tail, label) {
    if (rows.length <= head + tail + 2) { rows.forEach(function (r) { box.appendChild(r); }); return; }
    var hidden = rows.slice(head, rows.length - tail);
    rows.slice(0, head).forEach(function (r) { box.appendChild(r); });
    var skip = el("button", "dk-skip", label(hidden.length));
    skip.type = "button";
    skip.addEventListener("click", function () { hidden.forEach(function (r) { r.hidden = false; }); skip.remove(); });
    box.appendChild(skip);
    hidden.forEach(function (r) { r.hidden = true; box.appendChild(r); });
    rows.slice(rows.length - tail).forEach(function (r) { box.appendChild(r); });
  }

  function drawCode(box, file) {
    var code = el("div", "dk-code");
    file.hunks.forEach(function (hunk, h) {
      if (h > 0 || hunk.context) code.appendChild(el("span", "dk-hunk", hunk.context || "⋯"));
      var all = runs(hunk);
      all.forEach(function (run, r) {
        if (run.kind === "same") {
          var same = run.rows.map(function (x) { return codeRow("", x.newNo, "", x.s); });
          var edge = r === 0 ? [0, 3] : r === all.length - 1 ? [3, 0] : [3, 3];
          foldRows(code, same, edge[0], edge[1], function (n) { return plural(n, "unchanged line"); });
          return;
        }
        var paired = run.del.length === run.ins.length;
        var rows = [];
        run.del.forEach(function (d, i) {
          var segs = paired ? segments(wordDiff(d.s, run.ins[i].s) || []) : null;
          var close = segs && segs.length && similarity(segs, d.s, run.ins[i].s) >= 0.5;
          d.segs = close ? segs : null;
          rows.push(codeRow("dk-minus", d.no, "−", close ? function (c) {
            segs.forEach(function (s) { if (s.eq != null) c.appendChild(document.createTextNode(s.eq)); else if (s.del) c.appendChild(el("del", null, s.del)); });
          } : d.s));
        });
        run.ins.forEach(function (a, i) {
          var segs = paired ? run.del[i].segs : null;
          rows.push(codeRow("dk-plus", a.no, "+", segs ? function (c) {
            segs.forEach(function (s) { if (s.eq != null) c.appendChild(document.createTextNode(s.eq)); else if (s.ins) c.appendChild(el("ins", null, s.ins)); });
          } : a.s));
        });
        // A long run of new or removed lines (a new file) shows its start.
        if (!run.del.length || !run.ins.length) foldRows(code, rows, 14, 2, function (n) { return plural(n, "more line"); });
        else rows.forEach(function (x) { code.appendChild(x); });
      });
    });
    box.appendChild(code);
  }

  function looksLikeProse(file) {
    if (PROSE_EXT.test(file.name)) return true;
    var lens = [];
    file.hunks.forEach(function (h) { h.rows.forEach(function (r) { if (r.t !== " ") lens.push(r.s.length); }); });
    lens.sort(function (a, b) { return a - b; });
    return lens.length > 0 && lens[lens.length >> 1] > 160;
  }

  function drawDiff(d) {
    if (d.hasAttribute("data-dk")) return;
    var before = d.querySelector("template[data-before]"), after = d.querySelector("template[data-after]");
    var files;
    if (before && after) {
      var a = before.content.textContent.replace(/^\n+|\s+$/g, "").split("\n"), b = after.content.textContent.replace(/^\n+|\s+$/g, "").split("\n");
      files = [{ name: d.getAttribute("file") || "", added: b.length, removed: a.length, hunks: [{ oldStart: 1, newStart: 1, context: "", rows: a.map(function (s) { return { t: "-", s: s }; }).concat(b.map(function (s) { return { t: "+", s: s }; })) }] }];
      if (!d.hasAttribute("as")) d.setAttribute("as", "prose");
    } else {
      var src = d.querySelector('script[type="text/plain"], template, pre, textarea');
      var text = src ? (src.content ? src.content.textContent : src.textContent) : d.textContent;
      files = parseUnified(text);
    }
    if (!files.length) return;
    var as = d.getAttribute("as");
    d.textContent = "";
    files.forEach(function (file) {
      if (files.length === 1 && d.getAttribute("file")) file.name = d.getAttribute("file");
      var box = el("div", "dk-file"), head = el("div", "dk-file-head"), name = el("span");
      var cut = file.name.lastIndexOf("/");
      if (cut >= 0) name.appendChild(document.createTextNode(file.name.slice(0, cut + 1)));
      name.appendChild(el("b", null, file.name.slice(cut + 1) || "the change"));
      head.appendChild(name);
      var count = el("span", "dk-count");
      count.appendChild(el("span", "dk-add", "+" + file.added));
      count.appendChild(document.createTextNode(" "));
      count.appendChild(el("span", "dk-rem", "−" + file.removed));
      head.appendChild(count);
      box.appendChild(head);
      if (as === "prose" || (as !== "code" && looksLikeProse(file))) drawProse(box, file); else drawCode(box, file);
      d.appendChild(box);
    });
    d.setAttribute("data-dk", "");
  }

  // ── The product's own view of the thing ──────────────────────────────────
  // Where codecast runs: the app framing this page, or the public one.
  function appOrigin() {
    var meta = document.querySelector('meta[name="codecast-app"]');
    if (meta && /^https?:\/\//i.test(meta.content)) return meta.content.replace(/\/+$/, "");
    try {
      var up = location.ancestorOrigins && location.ancestorOrigins[0];
      if (up && /^https?:\/\/(localhost|127\.0\.0\.1|([a-z0-9-]+\.)?codecast\.sh)(:\d+)?$/i.test(up)) return up;
    } catch (e) { /* not framed */ }
    return "https://codecast.sh";
  }

  function drawView(v) {
    if (v.hasAttribute("data-dk")) return;
    var label = v.textContent.trim() || "Open it in the product", href = v.getAttribute("href"), ref = (v.getAttribute("ref") || "").trim();
    if (!(href && /^https?:\/\//i.test(href))) href = ref ? appOrigin() + "/view?ref=" + encodeURIComponent(ref) : null;
    v.textContent = "";
    if (href) {
      var a = el("a", null, label);
      a.href = href; a.target = "_blank"; a.rel = "noreferrer";
      if (ref) a.title = ref;
      v.appendChild(a);
    } else v.appendChild(el("span", null, label));
    v.setAttribute("data-dk", "");
  }

  function draw() {
    [].forEach.call(document.querySelectorAll("dk-msg"), drawMessage);
    [].forEach.call(document.querySelectorAll("dk-thread"), drawThread);
    [].forEach.call(document.querySelectorAll("dk-examples"), drawExamples);
    [].forEach.call(document.querySelectorAll("dk-diff"), drawDiff);
    [].forEach.call(document.querySelectorAll("dk-view"), drawView);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw); else draw();
  window.decisionKit = { draw: draw, parseUnified: parseUnified, wordDiff: wordDiff, segments: segments };
})();
