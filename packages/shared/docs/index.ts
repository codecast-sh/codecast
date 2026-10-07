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
/**
 * Every value docs.doc_type may hold, in the order tabs and pickers show
 * them. The convex schema derives its validator from this tuple and every
 * client derives its tabs from it, so a type added here reaches each surface
 * at once. Each client's style map is typed Record<DocType, ...>, so a type
 * that is in the tuple but missing from a map fails to compile instead of
 * dereferencing undefined at render (the docs list crashed on "decision"
 * when the tuple and the list page's map were two hand-kept copies).
 */
// docSync.submitSteps refuses steps from an editor that opened the doc before
// a CLI/API rewrite (docs.resetSync); the editor remounts from the new snapshot
// on its own, so the web error reporter ignores this wording.
export const DOC_REWRITTEN_ERROR = "Document was rewritten outside the editor; reload it";

export const DOC_TYPES = [
  "note",
  "plan",
  "design",
  "spec",
  "investigation",
  "handoff",
  // The long body of a `cast decide --doc` decision (session_decisions.doc_id).
  "decision",
  // A standing role's two documents (org-roles-standing.md T2): the charter
  // humans write, and the brief the role keeps as its memory.
  "charter",
  "brief",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  note: "Note",
  plan: "Plan",
  design: "Design",
  spec: "Spec",
  investigation: "Investigation",
  handoff: "Handoff",
  decision: "Decision",
  charter: "Charter",
  brief: "Brief",
};

/** The label for any stored doc_type; unknown values read as a note, like every client's style fallback. */
export function docTypeLabel(docType: string | null | undefined): string {
  return DOC_TYPE_LABELS[docType as DocType] ?? DOC_TYPE_LABELS.note;
}

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
 * origin) or when someone starred it — the star (stored as `pinned`) on a
 * machine-made doc is the deliberate "this one matters" gesture, the docs
 * analog of promoting a task onto the board.
 */
export function isOnHumanShelf(doc: {
  source?: string | null;
  pinned?: boolean | null;
}): boolean {
  return isHumanDocOrigin(doc) || !!doc.pinned;
}

/** Docs an agent org keeps about its own roles (a role's charter and brief).
 *  A charter is stamped human because a person may edit it, but it describes
 *  how the agents work, not a note of the person's. */
export const ROLE_DOC_TYPES: ReadonlySet<string> = new Set(["charter", "brief"]);

/**
 * The shelf in hosted mode, where the list is the person's own notes: the
 * human shelf without the agent org's role docs.
 */
export function isOnNotesShelf(doc: {
  source?: string | null;
  pinned?: boolean | null;
  doc_type?: string | null;
}): boolean {
  return isOnHumanShelf(doc) && !ROLE_DOC_TYPES.has(doc.doc_type ?? "");
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

export function splitFrontmatter(content: string): { front: string; body: string } {
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

/** How much of a doc rides along when someone mentions it; the rest is a read away. */
export const DOC_MENTION_EXCERPT_CHARS = 2000;
const DOC_MENTION_OUTLINE_MAX = 40;

/**
 * A long doc as an agent should first see it: the opening whole lines up to
 * `maxChars`, then the headings that follow with the line each starts on, so
 * the agent can read exactly the section it needs (`cast doc show <id> 52:`).
 * Line numbers count raw content lines from 1, the way `cast doc show` pages.
 */
export function docMentionExcerpt(content: string, maxChars: number = DOC_MENTION_EXCERPT_CHARS): {
  excerpt: string;
  truncated: boolean;
  shownLines: number;
  totalLines: number;
  outline: Array<{ line: number; heading: string }>;
} {
  const lines = content.split("\n");
  if (content.length <= maxChars) {
    return { excerpt: content, truncated: false, shownLines: lines.length, totalLines: lines.length, outline: [] };
  }
  let used = 0;
  let shownLines = 0;
  while (shownLines < lines.length && used + lines[shownLines].length + 1 <= maxChars) {
    used += lines[shownLines].length + 1;
    shownLines++;
  }
  // One enormous first line still shows something.
  const excerpt = shownLines > 0 ? lines.slice(0, shownLines).join("\n") : lines[0].slice(0, maxChars);
  const outline: Array<{ line: number; heading: string }> = [];
  let inFence = false;
  for (let i = shownLines; i < lines.length && outline.length < DOC_MENTION_OUTLINE_MAX; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,4})[ \t]+(.+?)[ \t#]*$/);
    if (m) outline.push({ line: i + 1, heading: `${m[1]} ${m[2].slice(0, 120)}` });
  }
  return { excerpt, truncated: true, shownLines: Math.max(shownLines, 1), totalLines: lines.length, outline };
}

/** The excerpt rendered as markdown, ending with how to read the rest. */
export function renderDocMentionExcerpt(content: string, docId: string, maxChars?: number): string {
  const ex = docMentionExcerpt(content, maxChars);
  if (!ex.truncated) return `${ex.excerpt.trim()}\n\n> \`cast doc show ${docId}\` for the document\n`;
  let md = `${ex.excerpt.trimEnd()}\n\n… excerpt ends at line ${ex.shownLines} of ${ex.totalLines}.`;
  if (ex.outline.length) {
    md += ` Sections after it:\n\n${ex.outline.map((o) => `- L${o.line} ${o.heading}`).join("\n")}\n`;
  }
  md += `\n> \`cast doc show ${docId} <from>:<to>\` reads a line range, \`cast doc grep ${docId} '<text>'\` searches it, \`--full\` reads it all\n`;
  return md;
}

export * from "./drafting";
