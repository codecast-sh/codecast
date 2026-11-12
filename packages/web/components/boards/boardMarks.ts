// The pure half of board text formatting (BoardRichText.tsx draws it): which
// lines are list items, which runs are marks, and the editor's format keys.

export const INLINE = /(\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|(?:https?:\/\/)[^\s)]+)/g;

export type RichLine = { kind: "text" | "bullet" | "number"; n?: number; text: string };

export function richLines(text: string): RichLine[] {
  return text.split("\n").map((line) => {
    const b = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (b) return { kind: "bullet", text: b[1] };
    const n = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (n) return { kind: "number", n: Number(n[1]), text: n[2] };
    return { kind: "text", text: line };
  });
}

/** Whether text uses any mark the canvas draws differently from plain text. */
export function hasMarks(text: string): boolean {
  return new RegExp(INLINE.source).test(text) || /^\s*([-*•]|\d+[.)])\s+/m.test(text);
}

/**
 * The editor's shortcuts: Cmd+B / Cmd+I / Cmd+Shift+X wrap the selection in
 * the mark (or unwrap it), Cmd+K turns it into a link. Returns the new value
 * and selection, or null when the key is not a formatting key.
 */
export function formatKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, value: string, start: number, end: number): { value: string; start: number; end: number } | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const k = e.key.toLowerCase();
  const mark = k === "b" ? "**" : k === "i" ? "*" : k === "x" && e.shiftKey ? "~~" : null;
  if (mark) {
    const sel = value.slice(start, end);
    const before = value.slice(Math.max(0, start - mark.length), start), after = value.slice(end, end + mark.length);
    if (before === mark && after === mark && !(mark === "*" && value.slice(start - 2, start) === "**")) {
      return { value: value.slice(0, start - mark.length) + sel + value.slice(end + mark.length), start: start - mark.length, end: end - mark.length };
    }
    return { value: value.slice(0, start) + mark + sel + mark + value.slice(end), start: start + mark.length, end: end + mark.length };
  }
  if (k === "k") {
    const sel = value.slice(start, end) || "link";
    const url = "https://";
    const next = `${value.slice(0, start)}[${sel}](${url})${value.slice(end)}`;
    const at = start + sel.length + 3;
    return { value: next, start: at, end: at + url.length };
  }
  return null;
}

/** Turn the lines the selection touches into a bulleted list, or back into plain lines. */
export function toggleList(value: string, start: number, end: number): { value: string; start: number; end: number } {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", end);
  const to = nl === -1 ? value.length : nl;
  const lines = value.slice(from, to).split("\n");
  const on = lines.every((l) => /^\s*[-*•]\s+/.test(l));
  const next = lines.map((l) => (on ? l.replace(/^\s*[-*•]\s+/, "") : `- ${l}`)).join("\n");
  const out = value.slice(0, from) + next + value.slice(to);
  return { value: out, start: from, end: from + next.length };
}

/** A stretch of text with one style: what an export draws as one span. */
export type Run = { t: string; b?: boolean; i?: boolean; s?: boolean; href?: string };

/** One line's marks as styled runs (the same marks the canvas draws). */
export function markRuns(line: string): Run[] {
  const out: Run[] = [];
  let last = 0;
  for (const m of line.matchAll(new RegExp(INLINE.source, "g"))) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: line.slice(last, at) });
    const t = m[0];
    if (t.startsWith("**")) out.push({ t: t.slice(2, -2), b: true });
    else if (t.startsWith("~~")) out.push({ t: t.slice(2, -2), s: true });
    else if (t.startsWith("*")) out.push({ t: t.slice(1, -1), i: true });
    else if (t.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      out.push(/^(https?:\/\/|mailto:)/i.test(mm[2]) ? { t: mm[1], href: mm[2] } : { t });
    } else {
      const url = t.replace(/[.,;:!?]+$/, "");
      out.push({ t: url.replace(/^https?:\/\//, ""), href: url });
      if (url.length < t.length) out.push({ t: t.slice(url.length) });
    }
    last = at + t.length;
  }
  if (last < line.length) out.push({ t: line.slice(last) });
  return out.filter((r) => r.t);
}

/**
 * Text with marks broken into lines no wider than `width`, at spaces, by a
 * measure of each styled word (the page's own font, in an export). List lines
 * get their bullet; a word longer than a line stays whole on its own line.
 */
export function wrapRuns(text: string, width: number, measure: (s: string, r: Run) => number): Run[][] {
  const out: Run[][] = [];
  for (const raw of text.split("\n")) {
    const li = richLines(raw)[0];
    const lead: Run[] = li.kind === "bullet" ? [{ t: "• " }] : li.kind === "number" ? [{ t: `${li.n}. ` }] : [];
    const words: Run[] = [];
    for (const r of [...lead, ...markRuns(li.text)]) for (const piece of r.t.split(/(?<= )/)) if (piece) words.push({ ...r, t: piece });
    let line: Run[] = [], used = 0;
    for (const w of words) {
      const wl = measure(w.t.trimEnd(), w);
      if (line.length && used + wl > width) { out.push(line); line = []; used = 0; }
      line.push(w);
      used += measure(w.t, w);
    }
    out.push(line.length ? line : [{ t: "" }]);
  }
  return out;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The rich editor's starting HTML for stored text: marks as tags, one <div> per line, list lines with a bullet. */
export function marksToHtml(text: string): string {
  return text.split("\n").map((raw) => {
    const li = richLines(raw)[0];
    const lead = li.kind === "bullet" ? "• " : li.kind === "number" ? `${li.n}. ` : "";
    const body = markRuns(li.text).map((r) => {
      let h = escHtml(r.t);
      if (r.b) h = `<b>${h}</b>`;
      if (r.i) h = `<i>${h}</i>`;
      if (r.s) h = `<s>${h}</s>`;
      if (r.href) h = `<a href="${escHtml(r.href)}">${h}</a>`;
      return h;
    }).join("");
    return `<div>${escHtml(lead)}${body || (lead ? "" : "<br>")}</div>`;
  }).join("");
}

/** Wrap text in a mark, keeping the spaces at its edges outside it (`a ** b**` is not bold in markdown). */
function wrapMark(mark: string, s: string): string {
  const lead = /^\s*/.exec(s)![0], tail = /\s*$/.exec(s)![0];
  return `${lead}${mark}${s.trim()}${mark}${tail}`;
}

function inlineMarks(n: Node): string {
  if (n.nodeType === 3) return (n.textContent ?? "").replace(/\u00a0/g, " ");
  if (n.nodeType !== 1) return "";
  const el = n as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === "br") return "\n";
  const inner = Array.from(el.childNodes).map(inlineMarks).join("");
  if (!inner.trim()) return inner;
  const style = (el.getAttribute("style") ?? "").toLowerCase();
  if (tag === "b" || tag === "strong" || /font-weight:\s*(bold|[6-9]00)/.test(style)) return wrapMark("**", inner);
  if (tag === "i" || tag === "em" || /font-style:\s*italic/.test(style)) return wrapMark("*", inner);
  if (tag === "s" || tag === "strike" || tag === "del" || /line-through/.test(style)) return wrapMark("~~", inner);
  if (tag === "a") {
    const href = el.getAttribute("href") ?? "";
    return /^(https?:\/\/|mailto:)/i.test(href) ? `[${inner}](${href})` : inner;
  }
  return inner;
}

/**
 * What the rich editor holds, back as stored text with marks: bold, italic,
 * strike and links become **, *, ~~ and [text](url); each block is a line; a
 * line shown with a bullet is stored as a "- " list line.
 */
export function editorToMarks(root: Node): string {
  const lines: string[] = [];
  let cur: string | null = null;
  for (const n of Array.from(root.childNodes)) {
    const block = n.nodeType === 1 && ["div", "p"].includes((n as Element).tagName.toLowerCase());
    if (block) {
      if (cur !== null) lines.push(cur);
      cur = null;
      lines.push(inlineMarks(n).replace(/\n$/, ""));
      continue;
    }
    cur = (cur ?? "") + inlineMarks(n);
  }
  if (cur !== null) lines.push(cur);
  return lines.flatMap((l) => l.split("\n")).map((l) => l.replace(/^• /, "- ")).join("\n").replace(/\n+$/, "");
}
