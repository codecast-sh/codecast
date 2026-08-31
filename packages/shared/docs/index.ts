/**
 * Doc provenance — the shared rule behind the web docs list, mobile's docs
 * segment, and the convex write paths, so the three never drift. Mirrors
 * @codecast/shared/tasks, which owns the same question for tasks.
 *
 * ORIGIN answers "did a person write this doc, or did a machine file it".
 * The complaint that started this (Aug 26) was the docs list drowning in
 * agent plan bodies and session-mined notes: thousands of machine rows
 * burying the handful of docs a person actually wrote or pinned.
 */

/**
 * Every value docs.source may hold. `plan_mode` comes from the agent
 * transcript importer, `file_sync` / `inline_extract` from session mining,
 * `import` from bulk imports.
 */
export type DocSource =
  | "human"
  | "agent"
  | "plan_mode"
  | "file_sync"
  | "inline_extract"
  | "import";

export type DocOrigin = "human" | "agent";

/**
 * The three classes a person tells apart, mirroring tasks (human board /
 * agent-internal / mined suggestions):
 *
 * - `human` — a person created the doc in the UI (or `cast doc create`
 *   outside a session).
 * - `agent` — an agent deliberately filed it: `cast doc create` in a session,
 *   a plan body, a plan-mode capture.
 * - `mined` — nobody filed it; machinery collected it: session extracts,
 *   synced files, bulk imports.
 */
export type DocOriginClass = "human" | "agent" | "mined";

const MINED_SOURCES = new Set(["file_sync", "inline_extract", "import"]);

export function docOriginClass(doc: { source?: string | null }): DocOriginClass {
  if (doc.source === "human") return "human";
  if (doc.source && MINED_SOURCES.has(doc.source)) return "mined";
  return "agent";
}

/**
 * Only an explicit `human` stamp counts as human. Everything else — including
 * a source literal added later — is machine origin, so a new writer is quiet
 * by default and never leaks onto the human shelf unlabeled.
 */
export function docOrigin(doc: { source?: string | null }): DocOrigin {
  return doc.source === "human" ? "human" : "agent";
}

export function isHumanDocOrigin(doc: { source?: string | null }): boolean {
  return docOrigin(doc) === "human";
}

/**
 * The human's shelf: what a person expects to see in the docs list without
 * asking for agent output. A doc is on it when a person wrote it (human
 * origin) or when someone pinned it — pinning a machine-made doc is the
 * deliberate "this one matters" gesture, the docs analog of promoting a task
 * onto the board.
 */
export function isOnHumanShelf(doc: {
  source?: string | null;
  pinned?: boolean | null;
}): boolean {
  return isHumanDocOrigin(doc) || !!doc.pinned;
}

/**
 * The doc source a plan-body doc should carry, derived from its plan's
 * source. Plans have their own source vocabulary (human, promoted, template,
 * fork, imported…); the doc only needs the origin answer, and anything a
 * person didn't file directly is machine work.
 */
export function docSourceForPlanSource(planSource: string | null | undefined): "human" | "agent" {
  return planSource === "human" ? "human" : "agent";
}

// ---------------------------------------------------------------------------
// Title = the leading heading of the body
//
// A doc is one text. Its title is not a separate field a person edits in a
// second box: it is the first heading of the content, the way a pasted page
// reads. Every writer (web editor, CLI, plan sync) goes through these helpers
// so the stored `title` column is always the text of that heading and the
// content always opens with it. Read-only surfaces that print the title in
// their own chrome drop it from the body with `stripTitleHeading`.
// ---------------------------------------------------------------------------

// Only real YAML frontmatter: the opening --- must be followed directly by a
// `key:` line. A doc whose body simply opens with a horizontal rule (---,
// blank line, prose) must not have everything up to the next --- swallowed.
const FRONTMATTER_RE = /^---[ \t]*\n(?=[A-Za-z0-9_-]+[ \t]*:)[\s\S]*?\n---[ \t]*(?:\n|$)/;

function splitFrontmatter(content: string): { front: string; body: string } {
  const fm = content.match(FRONTMATTER_RE);
  return fm ? { front: fm[0], body: content.slice(fm[0].length) } : { front: "", body: content };
}

/** The first non-blank line, if it is a markdown heading: its text and its span in `body`. */
function leadingHeadingMatch(body: string): { text: string; start: number; end: number } | null {
  const start = body.search(/\S/);
  if (start < 0) return null;
  const lineEnd = body.indexOf("\n", start);
  const end = lineEnd < 0 ? body.length : lineEnd;
  const m = body.slice(start, end).match(/^#{1,6}(?:[ \t]+(.*?))?[ \t#]*$/);
  if (!m) return null;
  return { text: (m[1] ?? "").trim(), start, end };
}

/** The heading a doc opens with ("" for a bare `#`), or null when the content starts with anything else. */
export function leadingHeading(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = leadingHeadingMatch(splitFrontmatter(content).body);
  return m ? m.text.slice(0, 200) : null;
}

/** The stored `title` for a body: its leading heading, else the given fallback. */
export function docTitleFromContent(content: string | null | undefined, fallback: string): string {
  return leadingHeading(content) || fallback;
}

/**
 * Write `title` in as the doc's leading heading, replacing one that is already
 * there. The body below the heading is untouched. An empty title is written
 * as a bare `#` so the editor still opens on a (placeholder) title block.
 */
export function setTitleHeading(title: string, content: string | null | undefined): string {
  const { front, body } = splitFrontmatter(content ?? "");
  const heading = title.trim() ? `# ${title.trim()}` : "#";
  const m = leadingHeadingMatch(body);
  if (m) return front + body.slice(0, m.start) + heading + body.slice(m.end);
  const rest = body.replace(/^\s+/, "");
  return front + heading + (rest ? `\n\n${rest}` : "\n");
}

/** Content that opens with a heading, adding `# title` only when it has none. */
export function withTitleHeading(title: string, content: string | null | undefined): string {
  return leadingHeading(content) !== null ? (content as string) : setTitleHeading(title, content);
}

/** The body without its leading heading, for surfaces that print the title themselves. */
export function stripTitleHeading(content: string | null | undefined): string {
  if (!content) return "";
  const { front, body } = splitFrontmatter(content);
  const m = leadingHeadingMatch(body);
  if (!m) return content;
  return front + body.slice(m.end).replace(/^\s*\n/, "");
}
