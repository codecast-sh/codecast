// Resolves the store's persisted `recentVisits` entries (ids + label
// snapshots) into display rows. Titles derive LIVE from the store at render —
// the persisted entry only carries a fallback label for things that have since
// left the store — so renames never leave the rail stale (lib/liveEntities
// philosophy). Shared by the header RecentlyViewedMenu, the Ctrl+Tab
// RecentSwitcher and the command palette's "Recently Visited" group.
import { pathLabel } from "./pathLabel";
import { channelDisplayName } from "./chatViews";
import { dmOtherIds } from "@codecast/shared/chat";
import { cleanTitle } from "./conversationProcessor";
import { convBucketMap, filterInboxScopeFromState, getProjectName, type RecentVisit } from "../store/inboxStore";
import { formatShortDate } from "./utils";

// What a visit points at, resolved live so a row can show the object's own
// detail (a task's status, a plan's progress, a label's session count).
export type VisitObjectType = "session" | "task" | "plan" | "doc" | "channel" | "label" | "project" | "page";

export type ResolvedVisit = {
  key: string;
  kind: RecentVisit["kind"];
  ts: number;
  title: string;
  objectType: VisitObjectType;
  // The live store row behind the visit (session, task, plan, doc, channel,
  // bucket). Absent when the store no longer holds it — the row then renders
  // from the title alone.
  entity?: any;
  // Sessions filed under a label / project view.
  sessionCount?: number;
  // Navigation payload — exactly one of these families is set, by kind.
  sessionId?: string;
  bucketId?: string;
  projectName?: string;
  projectPath?: string | null;
  path?: string;
};

function resolvePageObject(state: any, path: string): { objectType: VisitObjectType; entity?: any; title?: string } {
  const m = path.match(/^\/(tasks|docs|plans|chat)\/([^/?#]+)/);
  if (!m) return { objectType: "page" };
  const [, kind, id] = m;
  // Without this every open channel is a tab called "Chat" — pathLabel can only
  // say what the PATH means, and a channel's name lives in the store. That is
  // exactly what this resolver is for. The name alone: every surface that shows
  // it (tab bar, recent menu, sidebar) already draws the hash as the row's icon.
  if (kind === "chat") {
    const channel = state.chatChannels?.[id];
    if (!channel) return { objectType: "channel" };
    if (channel.kind === "dm") {
      return {
        objectType: "channel",
        entity: channel,
        title: channelDisplayName(
          { name: "", kind: "dm", dmMemberIds: dmOtherIds(channel.dm_key, String(state.currentUser?._id ?? "")) },
          state.teamMembers,
        ),
      };
    }
    return { objectType: "channel", entity: channel, title: channel.name || undefined };
  }
  if (kind === "tasks") {
    const t = state.tasks?.[id] ?? Object.values(state.tasks ?? {}).find((t: any) => t._id === id || t.short_id === id);
    return { objectType: "task", entity: t, title: (t as any)?.title };
  }
  if (kind === "docs") {
    const d = state.docDetails?.[id] ?? state.docs?.[id];
    return { objectType: "doc", entity: d, title: d?.display_title ?? d?.title };
  }
  const p = state.plans?.[id] ?? Object.values(state.plans ?? {}).find((p: any) => p._id === id || p.short_id === id);
  return { objectType: "plan", entity: p, title: (p as any)?.title };
}

// Sessions per label and per project, counted once per resolve and only when
// a view visit is present — the counts are the detail line of those rows.
function countViewSessions(state: any) {
  const byBucket = new Map<string, number>();
  const byProject = new Map<string, number>();
  const bucketByConv = convBucketMap(state.bucketAssignments ?? {});
  for (const s of Object.values(filterInboxScopeFromState(state)) as any[]) {
    const bucket = bucketByConv[s._id];
    if (bucket) byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
    const project = getProjectName(s.git_root, s.project_path);
    if (project !== "unknown") byProject.set(project, (byProject.get(project) ?? 0) + 1);
  }
  return { byBucket, byProject };
}

export function resolveRecentVisits(
  state: any,
  limit: number,
  opts?: { skipViews?: boolean },
): ResolvedVisit[] {
  const out: ResolvedVisit[] = [];
  let scoped: Record<string, any> | null = null;
  let counts: ReturnType<typeof countViewSessions> | null = null;
  for (const v of (state.recentVisits ?? []) as RecentVisit[]) {
    if (out.length >= limit) break;
    if (v.kind === "session") {
      // The cache holds rows from other scopes and previously viewed teams; a
      // session the inbox scope hides is not a place this workspace can go.
      scoped ??= state.sessions ? filterInboxScopeFromState(state) : {};
      if (state.sessions?.[v.key] && !scoped[v.key]) continue;
      const sess = state.sessions?.[v.key] ?? state.conversations?.[v.key];
      // Untitled blanks (pre-warm stubs the user summoned but never used) are
      // noise, and entries we can't name at all are unrenderable — skip both.
      if (sess && !sess.title && (sess.message_count ?? 0) === 0) continue;
      const title = cleanTitle(sess?.title || v.label || "");
      if (!title) continue;
      out.push({ key: v.key, kind: v.kind, ts: v.ts, title, objectType: "session", entity: sess, sessionId: v.key });
    } else if (v.kind === "view") {
      if (opts?.skipViews) continue;
      counts ??= countViewSessions(state);
      if (v.key.startsWith("label:")) {
        const id = v.key.slice("label:".length);
        const bucket = state.buckets?.[id];
        const name = bucket?.name ?? v.label;
        // A deleted/archived label is no longer a place you can go.
        if (!name || bucket?.archived_at) continue;
        out.push({
          key: v.key, kind: v.kind, ts: v.ts, title: name, objectType: "label", entity: bucket,
          sessionCount: counts.byBucket.get(id) ?? 0, bucketId: id,
        });
      } else {
        const name = v.label ?? v.key.slice("project:".length);
        out.push({
          key: v.key, kind: v.kind, ts: v.ts, title: name, objectType: "project",
          sessionCount: counts.byProject.get(name) ?? 0, projectName: name, projectPath: v.path ?? null,
        });
      }
    } else {
      const path = v.path ?? v.key.slice("page:".length);
      const obj = resolvePageObject(state, path);
      const title = obj.title ?? v.label ?? pathLabel(path);
      out.push({ key: v.key, kind: v.kind, ts: v.ts, title, objectType: obj.objectType, entity: obj.entity, path });
    }
  }
  return out;
}

export const VISIT_OBJECT_LABEL: Record<VisitObjectType, string> = {
  session: "Session",
  task: "Task",
  plan: "Plan",
  doc: "Doc",
  channel: "Channel",
  label: "Label",
  project: "Project",
  page: "Page",
};

export function visitTimeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return formatShortDate(ts);
}
