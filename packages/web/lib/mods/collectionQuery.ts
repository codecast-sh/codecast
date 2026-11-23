// What a mod reads (lib/mods/host.ts answers data.query and data.count from
// here): a store collection's rows as the person sees them, with the derived
// facts every mod would otherwise recompute, filtered, sorted and trimmed.

import { MOD_COLLECTIONS } from "@codecast/shared/contracts/mods";
import { useInboxStore, personSessionWorkState, placeInboxRows, isSub, type InboxSession } from "../../store/inboxStore";
import { WORKSPACE_SCOPED_KEYS } from "../../store/clientSyncRegistry";
import { activeWorkspaceKeyOf, filterByWorkspace } from "../workspaceScope";

/** The most rows one call returns. */
export const CALL_LIMIT = 500;

export type Query = {
  where?: Record<string, unknown>;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  fields?: string[];
  search?: string;
};

export function baseName(p?: string): string | undefined {
  if (!p) return undefined;
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || undefined;
}

/**
 * The person's inbox as the inbox itself places it: which section each of
 * their sessions sits in. The same placement the sidebar draws (memoized
 * there), so a mod never re-derives "is this waiting on me" from raw fields.
 */
type InboxView = { visible: Record<string, unknown>; placements: Map<string, { bucket: string }> };
export function inboxPlacements(): InboxView {
  try {
    const placed = placeInboxRows(useInboxStore.getState() as any, { scope: "mine" });
    return { visible: placed.visibleSessions, placements: placed.placements as any };
  } catch {
    return { visible: {}, placements: new Map() };
  }
}

/** A row as a mod sees it: the store's row plus the derived facts every mod would otherwise recompute. */
export function present(collection: string, row: any, inbox?: InboxView): any {
  if (collection === "sessions") {
    const s = row as any;
    let state: string | undefined;
    try { state = personSessionWorkState(s as InboxSession); } catch { state = undefined; }
    const me = String((useInboxStore.getState() as any).currentUser?._id ?? "");
    // Membership is the inbox's own row set; the section is its server-stamped
    // bucket when one has arrived, else the work state it sorts by.
    // Machine-started rows (subagents, workers, spawned fan-out) nest under their parent, never as the person's own card.
    const shown = !!inbox && (String(s._id) in inbox.visible || String(s.session_id) in inbox.visible) && !isSub(s as InboxSession);
    const bucket = inbox?.placements.get(String(s._id))?.bucket ?? inbox?.placements.get(String(s.session_id))?.bucket;
    return {
      ...row,
      state,
      // The section of the person's inbox the session sits in, or null when the inbox does not show it
      // (a subagent, a worker, a killed, stashed or filed session, someone else's).
      inbox: shown && bucket !== "hidden" ? (bucket ?? state ?? null) : null,
      mine: !!me && String(s.user_id ?? "") === me,
      // When the session last came to rest (its turn ended), for "how long has it waited".
      waiting_since: state && state !== "working" ? (s.turn_completed_at ?? s.agent_status_updated_at ?? s.updated_at ?? null) : null,
      project: baseName(s.git_root ?? s.project_path),
      title: s.title || s.short_title || undefined,
    };
  }
  return row;
}

const SCOPED = new Set<string>(WORKSPACE_SCOPED_KEYS);

/** A collection's rows as the person sees them: a workspace-scoped table holds only the active workspace's rows, the way its own pages show it. */
export function rowsOf(collection: string): any[] {
  const key = (MOD_COLLECTIONS as Record<string, string>)[collection];
  const st = useInboxStore.getState() as any;
  const raw = st[key];
  if (!raw) return [];
  const list = (Array.isArray(raw) ? raw : Object.values(raw)).filter((r: any) => r && typeof r === "object" && !String(r._id ?? "").startsWith("__"));
  return SCOPED.has(key) ? filterByWorkspace(list, activeWorkspaceKeyOf(st)) : list;
}

function matchOne(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return Array.isArray(c.in) && c.in.includes(value as never);
    if ("ne" in c) return value !== c.ne;
    if ("gt" in c) return typeof value === "number" && value > (c.gt as number);
    if ("lt" in c) return typeof value === "number" && value < (c.lt as number);
    if ("contains" in c) return typeof value === "string" && value.toLowerCase().includes(String(c.contains).toLowerCase());
    if ("exists" in c) return (value !== undefined && value !== null) === !!c.exists;
  }
  return value === cond;
}

export function queryCollection(collection: string, q: Query = {}): any[] {
  const inbox = collection === "sessions" ? inboxPlacements() : undefined;
  let rows = rowsOf(collection).map((r) => present(collection, r, inbox));
  if (q.where) rows = rows.filter((r) => Object.entries(q.where!).every(([k, cond]) => matchOne(k.includes(".") ? k.split(".").reduce((v: any, part) => v?.[part], r) : r[k], cond)));
  if (q.search) {
    const needle = q.search.toLowerCase();
    rows = rows.filter((r) => ["title", "name", "message", "description", "content", "subtitle"].some((f) => typeof r[f] === "string" && r[f].toLowerCase().includes(needle)));
  }
  if (q.sort) {
    const dir = q.order === "asc" ? 1 : -1;
    const k = q.sort;
    rows.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x === y) return 0;
      if (x === undefined || x === null) return 1;
      if (y === undefined || y === null) return -1;
      return (x > y ? 1 : -1) * dir;
    });
  }
  rows = rows.slice(0, Math.min(Math.max(q.limit ?? 200, 0), CALL_LIMIT));
  if (q.fields?.length) {
    const keep = new Set(["_id", ...q.fields]);
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
  }
  return rows;
}
