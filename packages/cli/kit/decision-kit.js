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
    // A mark's note inside a message reads under it, so the sentence stays whole.
    [].forEach.call(body.querySelectorAll("mark[note]"), function (mk) {
      var n = el("div", "dk-note", mk.getAttribute("note"));
      n.setAttribute("data-mark", "");
      m.appendChild(n);
    });
    m.setAttribute("data-dk", "");

    // The text a decision turns on is shown whole: the message at fault, and
    // any message set as a before or an after.
    if (m.hasAttribute("miss") || m.hasAttribute("full") || m.closest("dk-side")) return;

    // A brief message shows the paragraphs holding its marks; the rest folds.
    if (m.hasAttribute("brief") && body.querySelector("mark") && briefen(body, bubble)) return;

    // A long message folds. Length is judged by the text, not the rendered
    // height, so a short email in a narrow column stays whole.
    var text = body.textContent.trim();
    if (text.length > 1100 || text.split("\n").length > 18) {
      body.setAttribute("data-clamped", "");
      var more = el("button", "dk-more", "Show the whole message");
      more.type = "button";
      more.addEventListener("click", function () { body.removeAttribute("data-clamped"); more.remove(); });
      bubble.appendChild(more);
    }
  }

  // Splits a message body into paragraphs and hides each run of unmarked ones
  // behind a fold that names how much it holds. False when nothing would fold.
  function briefen(body, bubble) {
    var paras = [], cur = document.createDocumentFragment(), marked = false;
    function close() { var p = el("div", "dk-para"); p.appendChild(cur); if (marked) p.setAttribute("data-marked", ""); paras.push(p); cur = document.createDocumentFragment(); marked = false; }
    [].slice.call(body.childNodes).forEach(function (n) {
      if (n.nodeType === 3 && /\n\s*\n/.test(n.nodeValue)) {
        var bits = n.nodeValue.split(/\n\s*\n/);
        bits.forEach(function (b, i) { if (i) close(); if (b) cur.appendChild(document.createTextNode(b)); });
      } else { if (n.nodeType === 1 && (n.tagName === "MARK" || n.querySelector && n.querySelector("mark"))) marked = true; cur.appendChild(n); }
    });
    close();
    paras = paras.filter(function (p) { return p.textContent.trim(); });
    if (paras.every(function (p) { return p.hasAttribute("data-marked"); })) { body.textContent = ""; paras.forEach(function (p) { body.appendChild(p); }); return true; }
    body.textContent = "";
    var hidden = [];
    function fold() {
      if (!hidden.length) return;
      var group = hidden, words = group.reduce(function (n, p) { return n + (p.textContent.match(/\S+/g) || []).length; }, 0);
      var skip = el("button", "dk-skip dk-para-skip", "… " + plural(words, "more word"));
      skip.type = "button";
      skip.addEventListener("click", function () { group.forEach(function (p) { p.hidden = false; }); skip.remove(); });
      body.appendChild(skip);
      hidden = [];
    }
    paras.forEach(function (p) {
      if (p.hasAttribute("data-marked")) { fold(); body.appendChild(p); }
      else { p.hidden = true; hidden.push(p); body.appendChild(p); }
    });
    fold();
    return true;
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
    // The first message the page points at (the miss, or one carrying a mark)
    // and everything after it always show.
    var anchor = items.findIndex(function (c) { return c.hasAttribute("miss") || !!c.querySelector("mark"); });
    var from = Math.max(0, items.length - show);
    if (anchor >= 0) from = Math.min(from, anchor);
    var earlier = items.slice(0, from);
    if (!earlier.length) return;
    earlier.forEach(function (c) { c.hidden = true; });
    var count = earlier.filter(function (c) { return c.tagName === "DK-MSG"; }).length;
    var more = el("button", "dk-more", count ? "Show " + plural(count, "earlier message") : "Show what came before");
    more.type = "button";
    more.addEventListener("click", function () { earlier.forEach(function (c) { c.hidden = false; }); more.remove(); });
    t.insertBefore(more, items[0]);
  }

  // ── Screens ───────────────────────────────────────────────────────────────
  // A screenshot of the product, fit to the column and a tap from full size.
  function drawShot(s) {
    if (s.hasAttribute("data-dk")) return;
    var src = s.getAttribute("src"), note = s.textContent.trim();
    s.textContent = "";
    if (s.getAttribute("label")) s.appendChild(el("div", "dk-shot-label", s.getAttribute("label")));
    if (src) {
      var a = el("a", "dk-shot-frame"), img = el("img");
      a.href = src; a.target = "_blank"; a.rel = "noreferrer";
      img.src = src; img.alt = s.getAttribute("alt") || note || s.getAttribute("label") || "";
      a.appendChild(img);
      s.appendChild(a);
    }
    if (note) s.appendChild(el("p", "dk-shot-note", note));
    s.setAttribute("data-dk", "");
  }

  // Shots of one screen (before and after) share one frame, flipped by their
  // labels, so a change reads in place at any width. The frame holds the
  // tallest, so a flip never moves the page.
  function drawShots(g) {
    if (g.hasAttribute("data-dk")) return;
    var shots = [].slice.call(g.querySelectorAll(":scope > dk-shot"));
    if (shots.length < 2) { g.setAttribute("data-dk", ""); return; }
    var tabs = el("div", "dk-shot-tabs"), stack = el("div", "dk-shot-stack");
    tabs.setAttribute("role", "group");
    var buttons = shots.map(function (s, i) {
      var b = el("button", null, s.getAttribute("label") || "Shot " + (i + 1));
      b.type = "button";
      b.addEventListener("click", function () { show(i); });
      tabs.appendChild(b);
      stack.appendChild(s);
      return b;
    });
    function show(n) {
      shots.forEach(function (s, i) { s.toggleAttribute("data-off", i !== n); });
      buttons.forEach(function (b, i) { b.setAttribute("aria-pressed", String(i === n)); });
    }
    var cap = g.querySelector(":scope > figcaption");
    g.textContent = "";
    if (cap) g.appendChild(cap);
    g.appendChild(tabs);
    g.appendChild(stack);
    show(0);
    g.setAttribute("data-dk", "");
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
        (/^DK-(MSG|PAIR|GAP|VIEW|THREAD|DIFF|SHOTS?)$/.test(c.tagName) ? shows : says).appendChild(c);
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
      // A hunk's own counts say how long it runs, but a pasted diff is often
      // trimmed: a line no hunk row can be (a file or hunk header) ends it.
      var header = /^diff --git /.test(l) || /^@@ /.test(l) ||
        (/^--- /.test(l) && /^\+\+\+ /.test(lines[i + 1] || "") && /^@@ /.test(lines[i + 2] || ""));
      if (hunk && !header && (hunk.oldLeft > 0 || hunk.newLeft > 0) && /^([ +\-\\]|$)/.test(l)) {
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
    return seqDiff(tokens(a), tokens(b), function (t, s) { return { t: t, s: s }; }, true);
  }

  // Longest common subsequence of two token or line lists, as ops; `join`
  // merges neighbouring ops of one kind into a single run of text.
  function seqDiff(A, B, make, join) {
    var n = A.length, m = B.length;
    if (n * m > 6e6) return null;
    var w = m + 1, L = new Uint32Array((n + 1) * w), i, j;
    for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
    var ops = [];
    function push(t, s) { var last = ops[ops.length - 1]; if (join && last && last.t === t) last.s += s; else ops.push(make(t, s)); }
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
  // Only whole sentences fold: the sentence the stretch opens in (the text's own
  // opening, or the close of the sentence a change sits in) stays in view, and so
  // does the sentence the next change sits in, so nothing a reader sees is cut
  // mid-clause. A sentence too long to keep whole is cut at a line break or a space.
  var SENTENCE_END = /[.!?:;]["'\u201d\u2019)\]]?(?=\s|$)|\n/g;
  function appendUnchanged(parent, text) {
    var KEEP = 110, MIN = 320, LONG = 420;
    if (text.length < MIN) { parent.appendChild(document.createTextNode(text)); return; }
    var ends = [], m;
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(text))) ends.push(m.index + m[0].length);
    var first = ends[0], last = ends.length ? ends[ends.length - 1] : -1;
    if (last === text.length || /^\s*$/.test(text.slice(last))) last = ends.length > 1 ? ends[ends.length - 2] : -1;
    var headAt = first != null && first <= LONG ? first : (text.indexOf(" ", KEEP) + 1 || KEEP);
    var tailAt = last > 0 && text.length - last <= LONG ? last : text.lastIndexOf(" ", text.length - KEEP);
    while (/\s/.test(text.charAt(headAt))) headAt++;
    var head = text.slice(0, headAt);
    tailAt = Math.max(head.length, tailAt);
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
        if (fold) appendUnchanged(parent, s.eq);
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

  // Removed text is struck, added text is lit, kept text is plain: the one
  // convention every prose change reads in, however much of it changed.
  function proseBlock(tag, text) {
    var p = el("p", "dk-prose");
    p.appendChild(el(tag, null, text));
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

  // A prompt's markdown reads as what it marks: **bold** as bold and `code` as
  // code, with the marks themselves gone, also where a change split them.
  function renderMarkdown(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [], n;
    while ((n = walker.nextNode())) if (/\*\*[^*\n]+\*\*|`[^`\n]+`/.test(n.nodeValue)) nodes.push(n);
    nodes.forEach(function (node) {
      var parts = node.nodeValue.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/), frag = document.createDocumentFragment();
      parts.forEach(function (part, i) {
        if (!part) return;
        if (i % 2 === 0) frag.appendChild(document.createTextNode(part));
        else if (part.charAt(0) === "`") frag.appendChild(el("code", null, part.slice(1, -1)));
        else frag.appendChild(el("strong", null, part.slice(2, -2)));
      });
      node.parentNode.replaceChild(frag, node);
    });
    // A heading reads as a heading, without its marks.
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); nodes = [];
    while ((n = walker.nextNode())) if (/(^|\n)#{1,6} \S/.test(n.nodeValue)) nodes.push(n);
    nodes.forEach(function (node) {
      var parts = node.nodeValue.split(/((?:^|\n)#{1,6} [^\n]*)/), frag = document.createDocumentFragment();
      parts.forEach(function (part, i) {
        if (!part) return;
        if (i % 2 === 0) { frag.appendChild(document.createTextNode(part)); return; }
        var nl = part.charAt(0) === "\n";
        if (nl) frag.appendChild(document.createTextNode("\n"));
        frag.appendChild(el("strong", "dk-h", part.replace(/^\n?#{1,6} /, "")));
      });
      node.parentNode.replaceChild(frag, node);
    });
    // A bold mark a change split in two has nothing left to mark: drop it.
    walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while ((n = walker.nextNode())) if (n.nodeValue.indexOf("**") >= 0) n.nodeValue = n.nodeValue.replace(/\*\*/g, "");
  }

  // Prose reads as paragraphs and list items, as markdown does: a source's hard
  // wrap inside a paragraph is a space, so every box reflows alike.
  // A heading is a line of its own, never the start of the paragraph under it.
  function reflow(s) {
    var lines = s.split("\n"), out = lines[0];
    for (var i = 1; i < lines.length; i++) {
      var prev = lines[i - 1], cur = lines[i];
      var joins = prev.length > 0 && !/^\s*#{1,6}\s/.test(prev) && /^[ \t]*(?:[^\s\-*+#>\d]|\d+[^.\d]|\d+\.\S)/.test(cur);
      out += joins ? " " + cur.replace(/^[ \t]+/, "") : "\n" + cur;
    }
    return out;
  }

  function drawProse(box, file) {
    file.hunks.forEach(function (hunk) {
      var all = runs(hunk);
      all.forEach(function (run, r) {
        // Kept text reads in its place: the paragraph touching each change (and
        // the text's opening) stays in view, folded in its middle when long;
        // every other unchanged paragraph waits behind one button, so a small
        // change in a long text reads as the change, and the whole text is a
        // click away.
        if (run.kind !== "change") {
          var kept = reflow(run.rows.map(function (x) { return x.s; }).join("\n")).trim();
          if (!kept) return;
          var k = el("div", "dk-change dk-kept"), paras = kept.split(/\n{2,}/), last = paras.length - 1;
          var before = all[r + 1] && all[r + 1].kind === "change", after = all[r - 1] && all[r - 1].kind === "change";
          var hidden = [];
          var flush = function () {
            if (!hidden.length) return;
            var held = hidden; hidden = [];
            var more = el("button", "dk-skip", plural(held.length, "unchanged paragraph"));
            more.type = "button";
            more.addEventListener("click", function () { held.forEach(function (q) { q.hidden = false; }); more.remove(); });
            k.appendChild(more);
            held.forEach(function (q) { q.hidden = true; k.appendChild(q); });
          };
          paras.forEach(function (para, i) {
            var q = el("p", "dk-prose");
            appendUnchanged(q, para);
            var shown = paras.length <= 3 || (i === 0 && (after || r === 0)) || (i === last && before);
            if (shown) { flush(); k.appendChild(q); } else hidden.push(q);
          });
          flush();
          renderMarkdown(k);
          dimTemplate(k);
          box.appendChild(k);
          return;
        }
        var a = reflow(run.del.map(function (x) { return x.s; }).join("\n")), b = reflow(run.ins.map(function (x) { return x.s; }).join("\n"));
        var change = el("div", "dk-change");
        if (!a.trim()) change.appendChild(proseBlock("ins", b));
        else if (!b.trim()) change.appendChild(proseBlock("del", a));
        else {
          var ops = wordDiff(a, b), segs = ops && segments(ops);
          // Mostly kept old text reads best inline, however much was added to it.
          var kept = segs ? segs.reduce(function (n, s) { return n + (s.eq != null ? s.eq.length : 0); }, 0) / Math.max(1, a.length) : 0;
          if (!segs || (similarity(segs, a, b) < 0.3 && kept < 0.7)) {
            change.appendChild(proseBlock("del", a));
            change.appendChild(proseBlock("ins", b));
          } else {
            var p = el("p", "dk-prose");
            inline(p, segs, true);
            change.appendChild(p);
          }
        }
        renderMarkdown(change);
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
    // The label is the file path, or a <figcaption> in words (any quotes are safe there).
    var caption = d.querySelector(":scope > figcaption"), named = caption ? caption.textContent.replace(/\s+/g, " ").trim() : d.getAttribute("file");
    if (caption) caption.remove();
    var before = d.querySelector("template[data-before]"), after = d.querySelector("template[data-after]");
    var files;
    if (before && after) {
      var a = before.content.textContent.replace(/^\n+|\s+$/g, "").split("\n"), b = after.content.textContent.replace(/^\n+|\s+$/g, "").split("\n");
      var rows = seqDiff(a, b, function (t, s) { return { t: t === "=" ? " " : t, s: s }; }, false)
        || a.map(function (s) { return { t: "-", s: s }; }).concat(b.map(function (s) { return { t: "+", s: s }; }));
      files = [{ name: named || "", hunks: [{ oldStart: 1, newStart: 1, context: "", rows: rows }] }];
      if (!d.hasAttribute("as")) d.setAttribute("as", "prose");
    } else {
      var src = d.querySelector('script[type="text/plain"], template, pre, textarea');
      var text = src ? (src.content ? src.content.textContent : src.textContent) : d.textContent;
      files = parseUnified(text);
    }
    if (!files.length) return;
    var as = d.getAttribute("as");
    d.textContent = "";
    // Code is how a change is made, not what it does to people: every file
    // drawn as code waits behind one line naming what changed, so the page
    // leads with its words and pictures. Prose (the words a person or an agent
    // meets) stays open, since those words are the behaviour.
    var code = null, codeNames = [], added = 0, removed = 0;
    files.forEach(function (file) {
      if (files.length === 1 && named) file.name = named;
      var box = el("div", "dk-file"), head = el("div", "dk-file-head"), name = el("span");
      // A file path reads as a path; any other name is a caption in words.
      var isPath = /^[^\s]+$/.test(file.name) && /[\/.]/.test(file.name);
      if (!isPath) head.classList.add("dk-caption");
      var cut = isPath ? file.name.lastIndexOf("/") : -1;
      if (cut >= 0) name.appendChild(document.createTextNode(file.name.slice(0, cut + 1)));
      var label = file.name.slice(cut + 1) || "The change";
      name.appendChild(el("b", null, isPath ? label : label.charAt(0).toUpperCase() + label.slice(1)));
      head.appendChild(name);
      box.appendChild(head);
      if (as === "prose" || (as !== "code" && looksLikeProse(file))) { drawProse(box, file); d.appendChild(box); return; }
      drawCode(box, file);
      if (!code) { code = el("details", "dk-code-fold"); code.appendChild(el("summary")); d.appendChild(code); }
      code.appendChild(box);
      codeNames.push(isPath ? label : file.name);
      file.hunks.forEach(function (h) { h.rows.forEach(function (r) { if (r.t === "+") added++; else if (r.t === "-") removed++; }); });
    });
    if (code) {
      var what = named && !/^[^\s]+$/.test(named) ? named.charAt(0).toUpperCase() + named.slice(1)
        : "The code: " + (codeNames.length > 3 ? plural(codeNames.length, "file") : codeNames.join(", "));
      code.firstChild.textContent = what + " · +" + added + " −" + removed + (added + removed === 1 ? " line" : " lines");
    }
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
      // The arrow travels with the label's last word, so a wrap never strands it.
      var a = el("a"), cut = label.lastIndexOf(" ");
      if (cut > 0) a.appendChild(document.createTextNode(label.slice(0, cut + 1)));
      a.appendChild(el("span", "dk-out", label.slice(cut + 1)));
      a.href = href; a.target = "_blank"; a.rel = "noreferrer";
      if (ref) a.title = ref;
      v.appendChild(a);
    } else v.appendChild(el("span", null, label));
    v.setAttribute("data-dk", "");
  }

  // An event's words, times and emphasis read as one line of text, and a long
  // one reads as a sentence rather than a caption.
  function drawEvent(ev) {
    if (ev.hasAttribute("data-dk")) return;
    var body = el("span", "dk-event-body");
    while (ev.firstChild) body.appendChild(ev.firstChild);
    trimEdges(body);
    ev.appendChild(body);
    if (body.textContent.replace(/\s+/g, " ").trim().length > 60) ev.setAttribute("long", "");
    ev.setAttribute("data-dk", "");
  }

  // A mark with a note outside a message says why it is marked right where it
  // sits; inside a message the note reads under the message.
  function drawMarkNote(m) {
    if (m.hasAttribute("data-dk") || m.closest("dk-msg")) return;
    var why = el("span", "dk-why", m.getAttribute("note"));
    m.parentNode.insertBefore(why, m.nextSibling);
    m.setAttribute("data-dk", "");
  }

  function draw() {
    try { if (window.self !== window.top) document.documentElement.classList.add("dk-framed"); } catch (e) { document.documentElement.classList.add("dk-framed"); }
    [].forEach.call(document.querySelectorAll("mark[note]"), drawMarkNote);
    [].forEach.call(document.querySelectorAll("dk-event"), drawEvent);
    [].forEach.call(document.querySelectorAll("dk-msg"), drawMessage);
    [].forEach.call(document.querySelectorAll("dk-thread"), drawThread);
    [].forEach.call(document.querySelectorAll("dk-shot"), drawShot);
    [].forEach.call(document.querySelectorAll("dk-shots"), drawShots);
    [].forEach.call(document.querySelectorAll("dk-examples"), drawExamples);
    [].forEach.call(document.querySelectorAll("dk-diff"), drawDiff);
    [].forEach.call(document.querySelectorAll("dk-view"), drawView);
    [].forEach.call(document.querySelectorAll("dk-tally"), drawTally);
    [].forEach.call(document.querySelectorAll("dk-cells"), drawCells);
    [].forEach.call(document.querySelectorAll("table"), drawTable);
  }

  // A grid of results as a screen draws it: each row's letters become cells
  // (P pass, F fail, anything else not run), its name whole beside them, and
  // its note (a count) at the end of the line, never wrapped under the cells.
  var CELL = { P: "pass", F: "fail" };
  function drawCells(g) {
    if (g.hasAttribute("data-dk")) return;
    [].forEach.call(g.querySelectorAll(":scope > dk-row"), function (r) {
      var letters = r.textContent.replace(/\s+/g, "");
      r.textContent = "";
      r.appendChild(el("span", "dk-cells-name", r.getAttribute("name") || ""));
      var cells = el("span", "dk-cells-run");
      for (var i = 0; i < letters.length; i++) {
        var c = el("i");
        c.setAttribute("data-v", CELL[letters[i].toUpperCase()] || "none");
        cells.appendChild(c);
      }
      r.appendChild(cells);
      r.appendChild(el("span", "dk-cells-note", r.getAttribute("note") || ""));
    });
    var legend = el("p", "dk-cells-legend");
    [["pass", "pass"], ["fail", "fail"], ["none", "not run"]].forEach(function (k) {
      var i = el("i"); i.setAttribute("data-v", k[0]);
      var s = el("span"); s.appendChild(i); s.appendChild(document.createTextNode(k[1]));
      legend.appendChild(s);
    });
    g.appendChild(legend);
    g.setAttribute("data-dk", "");
  }

  // A tally's numbers are counted from the people it lists, so a count can
  // never differ from the cases it opens to.
  function drawTally(t) {
    if (t.hasAttribute("data-dk")) return;
    var total = 0;
    [].forEach.call(t.querySelectorAll(":scope > dk-group"), function (g) {
      var n = g.querySelectorAll(":scope > ul > li, :scope > ol > li").length;
      total += n;
      var h = g.querySelector(":scope > h3");
      if (h) h.insertBefore(el("b", "dk-count", String(n)), h.firstChild);
      // A long group shows its first people and keeps the rest one click away.
      var list = g.querySelector(":scope > ul, :scope > ol"), items = list ? [].slice.call(list.children) : [];
      if (items.length > 10) {
        var hidden = items.slice(8);
        hidden.forEach(function (li) { li.hidden = true; });
        var more = el("button", "dk-skip", hidden.length + " more");
        more.type = "button";
        more.addEventListener("click", function () { hidden.forEach(function (li) { li.hidden = false; }); more.remove(); });
        g.appendChild(more);
      }
    });
    var of = t.getAttribute("of");
    if (of) t.insertBefore(el("p", "dk-tally-of", plural(total, of, t.getAttribute("of-many") || of)), t.firstChild);
    t.setAttribute("data-dk", "");
  }

  // Each cell carries its column's header, so a narrow page can stack a row
  // as label and value instead of pushing its last columns out of view.
  function drawTable(t) {
    if (t.hasAttribute("data-dk")) return;
    var heads = [].map.call(t.querySelectorAll("thead th, tr:first-child > th"), function (h) { return h.textContent.trim(); });
    [].forEach.call(t.querySelectorAll("tr"), function (tr) {
      [].forEach.call(tr.children, function (c, i) { if (c.tagName === "TD" && heads[i]) c.setAttribute("data-label", heads[i]); });
    });
    if (heads.length > 2) t.setAttribute("data-stack", "");
    t.setAttribute("data-dk", "");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw); else draw();
  window.decisionKit = { draw: draw, parseUnified: parseUnified, wordDiff: wordDiff, segments: segments };
})();
