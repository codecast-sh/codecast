// Resolves the store's persisted `recentVisits` entries (ids + label
// snapshots) into display rows. Titles derive LIVE from the store at render —
// the persisted entry only carries a fallback label for things that have since
// left the store — so renames never leave the rail stale (lib/liveEntities
// philosophy). Shared by the header RecentlyViewedMenu and the command
// palette's "Recently Visited" group.
import { pathLabel } from "../components/TabBar";
import { cleanTitle } from "./conversationProcessor";
import type { RecentVisit } from "../store/inboxStore";

export type ResolvedVisit = {
  key: string;
  kind: RecentVisit["kind"];
  ts: number;
  title: string;
  // Navigation payload — exactly one of these families is set, by kind.
  sessionId?: string;
  bucketId?: string;
  projectName?: string;
  projectPath?: string | null;
  path?: string;
};

function resolvePageTitle(state: any, path: string): string | null {
  const m = path.match(/^\/(tasks|docs|plans)\/([^/?#]+)/);
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === "tasks") {
    const t = state.tasks?.[id] ?? Object.values(state.tasks ?? {}).find((t: any) => t._id === id || t.short_id === id);
    return (t as any)?.title ?? null;
  }
  if (kind === "docs") {
    const d = state.docDetails?.[id] ?? state.docs?.[id];
    return d?.display_title ?? d?.title ?? null;
  }
  const p = state.plans?.[id] ?? Object.values(state.plans ?? {}).find((p: any) => p._id === id || p.short_id === id);
  return (p as any)?.title ?? null;
}

export function resolveRecentVisits(
  state: any,
  limit: number,
  opts?: { skipViews?: boolean },
): ResolvedVisit[] {
  const out: ResolvedVisit[] = [];
  for (const v of (state.recentVisits ?? []) as RecentVisit[]) {
    if (out.length >= limit) break;
    if (v.kind === "session") {
      const sess = state.sessions?.[v.key] ?? state.conversations?.[v.key];
      // Untitled blanks (pre-warm stubs the user summoned but never used) are
      // noise, and entries we can't name at all are unrenderable — skip both.
      if (sess && !sess.title && (sess.message_count ?? 0) === 0) continue;
      const title = cleanTitle(sess?.title || v.label || "");
      if (!title) continue;
      out.push({ key: v.key, kind: v.kind, ts: v.ts, title, sessionId: v.key });
    } else if (v.kind === "view") {
      if (opts?.skipViews) continue;
      if (v.key.startsWith("label:")) {
        const id = v.key.slice("label:".length);
        const bucket = state.buckets?.[id];
        const name = bucket?.name ?? v.label;
        // A deleted/archived label is no longer a place you can go.
        if (!name || bucket?.archived_at) continue;
        out.push({ key: v.key, kind: v.kind, ts: v.ts, title: name, bucketId: id });
      } else {
        const name = v.label ?? v.key.slice("project:".length);
        out.push({ key: v.key, kind: v.kind, ts: v.ts, title: name, projectName: name, projectPath: v.path ?? null });
      }
    } else {
      const path = v.path ?? v.key.slice("page:".length);
      const title = resolvePageTitle(state, path) ?? v.label ?? pathLabel(path);
      out.push({ key: v.key, kind: v.kind, ts: v.ts, title, path });
    }
  }
  return out;
}

export function visitTimeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
