// Which agent session an editor works with. Pure functions over store rows, no
// React and no CodeMirror, so the Files page (which must not load the editor
// chunk) and the editor share one answer.
//
// The link, in order (docs/architecture/code-editor.md, Integration):
//   1. the session the person picked for this folder (or "None"),
//   2. the conversation beside the Files pane on the stage,
//   3. the most recently active session whose project or worktree holds the
//      vault root,
//   4. none.

import { SESSION_BLAME_HUES } from "../../repoView";

/** The fields of a session row the editor reads. A structural subset of the
 *  inbox store's InboxSession, so tests build rows by hand. */
export interface AgentSessionRow {
  _id: string;
  title?: string;
  short_title?: string | null;
  agent_type: string;
  project_path?: string;
  git_root?: string;
  updated_at: number;
  user_id?: string;
  owned_by_me?: boolean;
  is_subagent?: boolean;
  inbox_killed_at?: number | null;
  icon_color?: string;
  activity?: { text: string; tool: string; at: number } | null;
}

export type LinkSource = "picked" | "beside" | "folder" | "none";

export interface AgentLink {
  sessionId: string | null;
  source: LinkSource;
}

/** The person's choice for a folder: a session, or explicitly none. */
export type LinkOverride = string | "none" | undefined;

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** `path` is `root` or inside it. */
export function pathWithin(path: string | null | undefined, root: string | null | undefined): boolean {
  if (!path || !root) return false;
  const p = trimSlash(path);
  const r = trimSlash(root);
  return p === r || p.startsWith(r === "/" ? "/" : `${r}/`);
}

/** The folders a session works in: its project and its checkout root. */
export function sessionRoots(s: Pick<AgentSessionRow, "project_path" | "git_root">): string[] {
  return [s.project_path, s.git_root].filter((p): p is string => !!p);
}

/** The session works in a folder that holds `root` (the vault): edits it makes
 *  land in the files this editor shows. */
export function sessionCoversRoot(s: Pick<AgentSessionRow, "project_path" | "git_root">, root: string): boolean {
  return sessionRoots(s).some((r) => pathWithin(root, r));
}

/** The session writes in a folder holding `absPath`. */
export function sessionCoversFile(s: Pick<AgentSessionRow, "project_path" | "git_root">, absPath: string): boolean {
  return sessionRoots(s).some((r) => pathWithin(absPath, r));
}

/** A session this viewer may steer: their own, never a teammate's row that
 *  reached the cache through a link, and never a subagent. */
export function steerable(s: AgentSessionRow, viewerId: string | null): boolean {
  if (s.owned_by_me === false) return false;
  if (viewerId && s.user_id && s.user_id !== viewerId) return false;
  if (s.is_subagent) return false;
  if (s.inbox_killed_at) return false;
  return !!s._id;
}

/** Sessions for the picker: steerable, working in this folder, most recently
 *  active first. */
export function candidateSessions<T extends AgentSessionRow>(rows: Iterable<T>, root: string | null, viewerId: string | null, limit = 12): T[] {
  if (!root) return [];
  const out: T[] = [];
  for (const s of rows) if (s && steerable(s, viewerId) && sessionCoversRoot(s, root)) out.push(s);
  out.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return out.slice(0, limit);
}

/** The session a stage pane shows, from its path: /conversation/<id>,
 *  /inbox?s=<id>, or the bare inbox showing the focused conversation. */
export function sessionOfPanePath(path: string, currentSessionId: string | null): string | null {
  const [pathname, query = ""] = path.split("?");
  const conv = /^\/conversation\/([A-Za-z0-9_-]+)$/.exec(pathname);
  if (conv) return conv[1];
  if (pathname === "/inbox" || pathname.startsWith("/inbox/")) {
    const s = new URLSearchParams(query).get("s");
    return s || currentSessionId;
  }
  return null;
}

const isFilesPath = (path: string) => /^\/(files|vault)(\/|\?|$)/.test(path);

interface StageTabLike {
  id: string;
  path: string;
  layout?: unknown;
}

function leafPaths(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as { type?: string; path?: string; children?: unknown[] };
  if (n.type === "leaf") return typeof n.path === "string" ? [n.path] : [];
  return (n.children ?? []).flatMap(leafPaths);
}

/** The conversation sharing a stage with a Files pane: the active tab's when it
 *  holds one, else any tab's. Null when Files is alone on its tab. */
export function besideSessionId(tabs: readonly StageTabLike[], activeTabId: string | null, currentSessionId: string | null): string | null {
  const ordered = [...tabs].sort((a, b) => Number(b.id === activeTabId) - Number(a.id === activeTabId));
  for (const tab of ordered) {
    const paths = leafPaths(tab.layout);
    if (paths.length < 2 || !paths.some(isFilesPath)) continue;
    for (const p of paths) {
      if (isFilesPath(p)) continue;
      // Only the focused conversation of THIS window is the bare inbox's.
      const id = sessionOfPanePath(p, tab.id === activeTabId ? currentSessionId : null);
      if (id) return id;
    }
  }
  return null;
}

/** The editor's linked session. */
export function resolveLink(opts: {
  override: LinkOverride;
  besideId: string | null;
  candidates: readonly AgentSessionRow[];
  /** Whether a session id still names a row the viewer can steer. */
  exists: (id: string) => boolean;
}): AgentLink {
  const { override, besideId, candidates, exists } = opts;
  if (override === "none") return { sessionId: null, source: "none" };
  if (override && exists(override)) return { sessionId: override, source: "picked" };
  if (besideId && exists(besideId)) return { sessionId: besideId, source: "beside" };
  const first = candidates[0];
  return first ? { sessionId: first._id, source: "folder" } : { sessionId: null, source: "none" };
}

/** What a session is called in tight chrome. */
export function sessionShortTitle(s: Pick<AgentSessionRow, "title" | "short_title"> | null | undefined): string {
  const raw = (s?.short_title || s?.title || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return "Untitled session";
  return raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
}

const SOL_NAMES = new Set(["blue", "green", "magenta", "orange", "cyan", "violet", "yellow", "red"]);

/** A session's color: its own icon color when it has one, else a stable hue
 *  from the palette session blame uses. */
export function sessionColor(s: Pick<AgentSessionRow, "_id" | "icon_color"> | string | null | undefined): string {
  if (!s) return "var(--sol-text-dim)";
  const row = typeof s === "string" ? { _id: s } : s;
  const own = typeof row === "object" && "icon_color" in row ? row.icon_color : undefined;
  if (own) {
    if (/^(#|var\(|rgb|hsl|oklch)/.test(own)) return own;
    if (SOL_NAMES.has(own)) return `var(--sol-${own})`;
  }
  let h = 0;
  for (let i = 0; i < row._id.length; i++) h = (h * 31 + row._id.charCodeAt(i)) >>> 0;
  return SESSION_BLAME_HUES[h % SESSION_BLAME_HUES.length];
}

/** The neutral color of an edit no session can be named for. */
export const UNKNOWN_WRITER_COLOR = "var(--sol-text-muted)";
