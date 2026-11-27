// Which agent session an editor works with. Pure functions over store rows, no
// React and no CodeMirror, so the Files page (which must not load the editor
// chunk) and the editor share one answer.
//
// The link, in order (docs/architecture/code-editor.md, Integration):
//   1. the session the person picked for this folder (or "None"),
//   2. the conversation beside the Files pane on the stage,
//   3. the most recently active session whose project or worktree holds the
//      vault root,
//   each only on the vault's machine (sessionOnMachine),
//   4. none.

import { SESSION_BLAME_HUES } from "../../repoView";
import { directConversationId } from "../../desktopHandoff";
import { inboxTabSessionId } from "../../pathLabel";
import { isFilesPath } from "../../vault/vaultHref";
import { leavesOf, type StageNode } from "../../../store/stageSplit";

/** The fields of a session row the editor reads. A structural subset of the
 *  inbox store's InboxSession, so tests build rows by hand. */
export interface AgentSessionRow {
  _id: string;
  title?: string;
  short_title?: string | null;
  agent_type: string;
  project_path?: string;
  git_root?: string;
  /** The machine running the session; unset until routing assigns one. */
  owner_device_id?: string | null;
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

/** A home directory or the filesystem root: a session started there holds
 *  every repo on the machine and works in none of them in particular. */
export function isBroadRoot(path: string): boolean {
  const p = trimSlash(path);
  return p === "/" || /^\/(Users|home)\/[^/]+$/.test(p) || p === "/root";
}

/** The folders that say where a session works: its roots, less a home
 *  directory. Folder linking and name hints read these; an absolute path in a
 *  tool call names its file whatever the session's folder. */
export function workRoots(s: Pick<AgentSessionRow, "project_path" | "git_root">): string[] {
  return sessionRoots(s).filter((r) => !isBroadRoot(r));
}

/** The session works in a folder that holds `root` (the vault): edits it makes
 *  land in the files this editor shows. */
export function sessionCoversRoot(s: Pick<AgentSessionRow, "project_path" | "git_root">, root: string): boolean {
  return workRoots(s).some((r) => pathWithin(root, r));
}

/** The session writes in a folder holding `absPath`. */
export function sessionCoversFile(s: Pick<AgentSessionRow, "project_path" | "git_root">, absPath: string): boolean {
  return workRoots(s).some((r) => pathWithin(absPath, r));
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

/** The session runs on `machine` (the vault's), or has no machine yet and
 *  routes on its next send. A session on another machine with the same paths
 *  reads and edits its own checkout, never the file on screen; with the
 *  vault's machine unknown, only an unrouted session qualifies. */
export function sessionOnMachine(s: Pick<AgentSessionRow, "owner_device_id">, machine: string | null): boolean {
  return !s.owner_device_id || (!!machine && s.owner_device_id === machine);
}

/** Sessions for the picker: steerable, working in this folder on the vault's
 *  machine, most recently active first. */
export function candidateSessions<T extends AgentSessionRow>(rows: Iterable<T>, root: string | null, machine: string | null, viewerId: string | null, limit = 12): T[] {
  if (!root) return [];
  const out: T[] = [];
  for (const s of rows) if (s && steerable(s, viewerId) && sessionOnMachine(s, machine) && sessionCoversRoot(s, root)) out.push(s);
  out.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return out.slice(0, limit);
}

/** The session a stage pane shows, from its path: a conversation pane
 *  (/conversation/<id>, the stage's own rule), an inbox deep link
 *  (/inbox?s=<id>), or the bare inbox showing the focused conversation. */
export function sessionOfPanePath(path: string, currentSessionId: string | null): string | null {
  // A pane opened at a message (`/conversation/<id>#msg-<mid>`) is still that conversation.
  const direct = directConversationId(path.replace(/#msg-[^#]*$/, "")) ?? inboxTabSessionId(path);
  if (direct) return direct;
  const pathname = path.split("?")[0];
  return pathname === "/inbox" || pathname.startsWith("/inbox/") ? currentSessionId : null;
}

interface StageTabLike {
  id: string;
  path: string;
  layout?: unknown;
  /** The conversation the editor on this tab was opened from (AppTab). */
  editorOpenedFrom?: string;
}

/** The conversation sharing a stage with this editor's Files pane. When the
 *  active tab holds a Files pane, that pane is this editor's and only its tab
 *  counts: Files alone there links nothing. Otherwise (the editor drawn off
 *  the active tab) another tab's conversation counts only when `covers` says
 *  its session works in this vault's folder, so a Files pane for another repo
 *  never lends its conversation. On a tab with several conversations, the one
 *  the Files pane was opened from (`editorOpenedFrom`, lib/filesPane) while it
 *  is still there, else the first. */
export function besideSessionId(tabs: readonly StageTabLike[], activeTabId: string | null, currentSessionId: string | null, covers: (sessionId: string) => boolean = () => true): string | null {
  const filesPaths = (tab: StageTabLike) => (tab.layout ? leavesOf(tab.layout as StageNode).map((l) => l.path) : [tab.path]);
  const active = tabs.find((t) => t.id === activeTabId);
  const ordered = active && filesPaths(active).some(isFilesPath) ? [active] : tabs;
  for (const tab of ordered) {
    const paths = filesPaths(tab);
    if (paths.length < 2 || !paths.some(isFilesPath)) continue;
    const mine = tab === active;
    // Only the focused conversation of THIS window is the bare inbox's.
    const ids = paths
      .filter((p) => !isFilesPath(p))
      .map((p) => sessionOfPanePath(p, mine ? currentSessionId : null))
      .filter((x): x is string => !!x && (mine || covers(x)));
    const opener = tab.editorOpenedFrom;
    if (opener && ids.includes(opener)) return opener;
    if (ids[0]) return ids[0];
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
  /** The link in force now. A folder link holds while its session is still a
   *  candidate, so two sessions active in one repo never trade places under
   *  the person; it re-ranks only when that session leaves the folder. */
  current?: AgentLink;
}): AgentLink {
  const { override, besideId, candidates, exists, current } = opts;
  if (override === "none") return { sessionId: null, source: "none" };
  if (override && exists(override)) return { sessionId: override, source: "picked" };
  if (besideId && exists(besideId)) return { sessionId: besideId, source: "beside" };
  if (current?.source === "folder" && current.sessionId && candidates.some((c) => c._id === current.sessionId)) return current;
  const first = candidates[0];
  return first ? { sessionId: first._id, source: "folder" } : { sessionId: null, source: "none" };
}

/** The picker's filter: every word of the query appears in the session's
 *  title or short title, ignoring case. An empty query matches all. */
export function matchesSessionQuery(s: Pick<AgentSessionRow, "title" | "short_title">, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${s.short_title ?? ""} ${s.title ?? ""}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** What a session is called in tight chrome. */
export function sessionShortTitle(s: Pick<AgentSessionRow, "title" | "short_title"> | null | undefined): string {
  const raw = (s?.short_title || s?.title || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return "Untitled session";
  return raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
}

const SOL_NAMES = new Set(["blue", "green", "magenta", "orange", "cyan", "violet", "yellow", "red"]);

/** The hues a session without its own color is given in the editor. Green,
 *  red and blue are left out: beside the code they mean added, deleted and
 *  modified (the git gutter), and a session bar in them would read as one. */
export const EDITOR_SESSION_HUES = SESSION_BLAME_HUES.filter(
  (h) => h !== "var(--sol-green)" && h !== "var(--sol-red)" && h !== "var(--sol-blue)",
);

/** A session's color: its own icon color when it has one, else a stable hue
 *  from EDITOR_SESSION_HUES. */
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
  return EDITOR_SESSION_HUES[h % EDITOR_SESSION_HUES.length];
}

/** The neutral color of an edit no session can be named for. */
export const UNKNOWN_WRITER_COLOR = "var(--sol-text-muted)";

// ── the session's git refs ──────────────────────────────────────────────────

/** A session's change as the diff panel holds it: a commit carries its hash
 *  when the commit's output named one. */
export interface SessionChangeRef {
  changeType: string;
  commitHash?: string;
}

/**
 * The git refs a session's own work stands on, from its commits in order:
 * `base` is where its work starts (the parent of its first commit; HEAD while
 * it has committed nothing, so all its work is uncommitted) and `last` is its
 * last commit. A commit whose hash went unrecorded leaves that ref null, and
 * the caller falls back. Read off the session's own commits, never the
 * branch's: on a trunk checkout other sessions' commits sit beside its own.
 */
export function sessionGitRefs(changes: readonly SessionChangeRef[]): { committed: boolean; base: string | null; last: string | null } {
  const commits = changes.filter((c) => c.changeType === "commit");
  if (!commits.length) return { committed: false, base: "HEAD", last: null };
  const hash = (c: SessionChangeRef | undefined) => (c?.commitHash && /^[0-9a-f]{7,64}$/i.test(c.commitHash) ? c.commitHash : null);
  const first = hash(commits[0]);
  return { committed: true, base: first ? `${first}^` : null, last: hash(commits[commits.length - 1]) };
}

/**
 * The base of each session that wrote committed lines of a file, from the
 * file's blame: the parent of the session's oldest commit still standing in
 * it, keyed by the session's full conversation id (its short one when that
 * is all the blame carries). Lines a session wrote but has not committed
 * name no commit and count for nothing here.
 */
export function blameSessionBases(hunks: readonly { sha?: string; time?: number; uncommitted?: boolean; session?: { id: string; conversation_id?: string; title?: string } }[]): Map<string, { ref: string; title?: string }> {
  const oldest = new Map<string, { sha: string; time: number; title?: string }>();
  for (const h of hunks) {
    if (!h.session || h.uncommitted || !h.sha || !/^[0-9a-f]{7,64}$/i.test(h.sha)) continue;
    const id = h.session.conversation_id ?? h.session.id;
    const time = h.time ?? Number.MAX_SAFE_INTEGER;
    const was = oldest.get(id);
    if (!was || time < was.time) oldest.set(id, { sha: h.sha, time, title: h.session.title });
  }
  return new Map([...oldest].map(([id, o]) => [id, { ref: `${o.sha}^`, title: o.title }]));
}
