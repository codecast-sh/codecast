// Shared pieces of undo labels. A label names the object the way the user
// knows it, quoted and short enough to fit a toast and a timeline row.
const MAX_QUOTED = 40;

/** “title”, cut to 40 characters; the fallback when the object has no title. */
export function quoted(text: string | null | undefined, fallback: string): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim() || fallback;
  const cut = clean.length > MAX_QUOTED ? `${clean.slice(0, MAX_QUOTED - 1).trimEnd()}…` : clean;
  return `“${cut}”`;
}

/** A session as the inbox names it, quoted. */
export function sessionTitle(state: any, id: string): string {
  return quoted(state?.sessions?.[id]?.title || state?.conversations?.[id]?.title, "session");
}

/** "3 sessions", "1 session". */
export function counted(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A label's trailing "(…)" is a note on the change, not its name: a toast
 *  shows the name as its line and the note under it, sentence-cased.
 *  "Killed “X” (agent stays stopped on undo)" → ["Killed “X”", "Agent stays stopped on undo"]. */
export function splitLabelNote(label: string): [title: string, note: string | undefined] {
  const m = /^(.*\S)\s+\(([^()]+)\)$/.exec(label);
  if (!m) return [label, undefined];
  return [m[1]!, m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1)];
}
