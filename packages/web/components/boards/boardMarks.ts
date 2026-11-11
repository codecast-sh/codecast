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
