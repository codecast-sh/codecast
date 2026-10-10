// A cause against the line itself (docs/architecture/line-map.md LX6): a
// person writes what should change about one node of the project's line, and
// the change is filed as a cause in the project, category `line`, its subject
// the node, the person's words its first signal. The line then runs it like
// any change. This module is the one shape of that filing: Ask an agent in the
// workspace and "Send through the line" on a station's prompt both build it
// here, and the store paints the same fields the server writes
// (convex/lineCause.ts).
/** The task category a cause against the line carries. */
export const LINE_CAUSE_CATEGORY = "line";

/** A part of the line a cause can name: a finder (kind "source"), a station, or the whole line (kind "line", subject `line:whole`). */
export type LineSubjectNode = { id: string; source?: string | null; kind: "source" | "station" | "decide" | "ship" | "watch" | "signals" | "causes" | "line" };

/** The subject a line cause names its node by: `line:station:prove`,
 *  `line:finder:agentwatch`, `line:profile:watch_days`, `line:signals`. */
export function lineSubject(node: LineSubjectNode): string {
  if (node.kind === "source" && node.source) return `line:finder:${node.source.toLowerCase()}`;
  if (node.kind === "station" || node.kind === "decide" || node.kind === "ship" || node.kind === "watch") return `line:station:${node.id}`;
  return `line:${node.id}`;
}

export const profileSubject = (key: string) => `line:profile:${key}`;

/** What travels to the server: the cause's title and the signal's words. */
export type LineCauseFields = {
  subject: string;
  title: string;
  detail_md: string;
};

const TITLE_MAX = 120;

/** The first line of what the person wrote, cut at a word near the limit. */
export function causeTitle(words: string, fallback: string): string {
  const first = words.trim().split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!first) return fallback;
  if (first.length <= TITLE_MAX) return first;
  const cut = first.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > 60 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

/**
 * The filing for a node: the person's words as the signal, and a proposed
 * station prompt, when they wrote one in the editor, attached under them as
 * the change they propose. A filing with neither is no filing (null).
 */
export function lineCauseFields(opts: { subject: string; label: string; words: string; draft?: { field: "prompt" | "script"; text: string } }): LineCauseFields | null {
  const words = opts.words.trim();
  const draft = opts.draft?.text.trim() ? opts.draft : undefined;
  if (!words && !draft) return null;
  const fallback = draft ? `Change the ${opts.label} station's ${draft.field}` : `Change ${opts.label} on the line`;
  const parts = [words || `A proposed ${draft!.field} for ${opts.label}, written in its editor.`];
  if (draft) {
    // A fence longer than any backtick run inside keeps the text exact.
    const fence = "`".repeat(Math.max(3, ...[...draft.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    parts.push(`Proposed ${draft.field} for ${opts.label} (the whole text):`, `${fence}\n${draft.text}\n${fence}`);
  }
  return { subject: opts.subject, title: causeTitle(words, fallback), detail_md: parts.join("\n\n") };
}
