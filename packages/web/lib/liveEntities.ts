// Canonical "live entity" derivation layer.
//
// Convex queries return records ENRICHED with derived/joined fields:
//   task.assignee_info  (from task.assignee + the user record)
//   plan.progress       (aggregated from the plan's task statuses)
//   plan.tasks          (the plan's tasks, embedded as a snapshot)
//   doc.display_title    (parsed from doc.content)
// Those fields are SNAPSHOTS. When the store optimistically mutates the
// underlying RAW field (e.g. updateTask sets task.assignee), the derived twin
// does NOT update until the server round-trips and re-enriches — which is the
// root of every "assignment isn't instant"-class bug.
//
// The fix is to DERIVE these fields at render from the raw fields + live
// reference data (the team roster, the live task collection) — never to store
// and field-protect them. Storing them doesn't work: derived fields are objects
// and the store's field-protection reconciles by ===, so an optimistic object
// can never match the server's re-enriched object and would freeze forever.
// Auto-deriving in the sync layer doesn't work either: it bypasses syncTable's
// no-change early-return and re-pushes the whole collection on every no-op sync
// (the "listInboxSessions churn" jank class).
//
// So: render-time derivation is the default. Whenever you display a
// derived/enriched field for an entity that also lives in the store, route it
// through these helpers.

type Member = { _id: string; name?: string; email?: string; image?: string; github_avatar_url?: string; github_username?: string };
type AssigneeInfo = { name: string; image?: string; github_username?: string } | null;

/**
 * Resolve a task/doc assignee's display info from the live team roster, keyed by
 * the (optimistically-updated) assignee id. The server-enriched `fallback` is
 * used only for ids not in the local roster, so a just-reassigned task shows the
 * right person instantly while anyone outside the roster still renders.
 */
export function resolveAssigneeInfo(
  assignee: string | null | undefined,
  fallback: any,
  teamMembers: Member[] | null | undefined,
  currentUser: Member | null | undefined,
): AssigneeInfo {
  if (!assignee) return null;
  const m = teamMembers?.find((x) => x && x._id === assignee);
  if (m) return { name: m.name || m.email || "Unknown", image: m.image || m.github_avatar_url, github_username: m.github_username };
  if (currentUser && (assignee === currentUser._id || assignee === "me")) {
    return { name: currentUser.name || currentUser.email || "Unknown", image: currentUser.image || currentUser.github_avatar_url, github_username: currentUser.github_username };
  }
  return fallback ?? { name: String(assignee) };
}

type SessionAuthor = { name: string; avatar?: string | null } | null;

/**
 * Resolve the author of an inbox session FOR DISPLAY — or null when the session
 * is the current user's own (or the author can't be named). The inbox cache is
 * user-scoped, so a synced row is always "mine"; a teammate's session only enters
 * it by injection (deep-link / search / command-palette), carrying either a
 * `user_id` (deep-link) or a source-provided `author_name`/`author_avatar` (search/
 * recent, which null those out for own sessions). Name/avatar derive from the live
 * roster by `user_id` when present (so a teammate's rename/avatar update shows
 * instantly), falling back to the source-provided fields.
 *
 * Safe before `currentUser` loads: a synced own row (user_id === me, but `me`
 * unknown yet) carries no author_name, so it resolves to null instead of briefly
 * mislabeling your own session.
 */
export function resolveSessionAuthor(
  session: { user_id?: string; author_name?: string | null; author_avatar?: string | null },
  currentUser: Member | null | undefined,
  teamMembers: Member[] | null | undefined,
): SessionAuthor {
  const uid = session.user_id;
  const myId = currentUser?._id;
  if (uid && myId && uid === myId) return null;            // definitely mine
  if (uid && !myId) {
    // user_id present but "me" not yet known: trust only an explicit author_name
    // (team sources already excluded own sessions) to avoid mislabeling my own row.
    return session.author_name ? { name: session.author_name, avatar: session.author_avatar } : null;
  }
  if (!uid && !session.author_name) return null;           // no author identity → mine
  const m = uid ? teamMembers?.find((x) => x && x._id === uid) : null;
  if (m) return { name: m.name || m.email || "Unknown", avatar: m.image || m.github_avatar_url };
  if (session.author_name) return { name: session.author_name, avatar: session.author_avatar };
  return null;
}

/**
 * Aggregate a plan's progress counts from a task list, mirroring the server's
 * recalcProgress so an optimistic status change moves the bar instantly.
 * Dropped tasks are excluded from the total (matching the server).
 */
export function computePlanProgress(
  tasks: Array<{ status?: string }> | null | undefined,
): { total: number; done: number; in_progress: number; open: number } {
  let total = 0, done = 0, in_progress = 0, open = 0;
  for (const t of tasks || []) {
    if (t.status === "dropped") continue;
    total++;
    if (t.status === "done") done++;
    else if (t.status === "in_progress" || t.status === "in_review") in_progress++;
    else if (t.status === "open" || t.status === "backlog") open++;
  }
  return { total, done, in_progress, open };
}

// The raw, user-editable fields the store owns authoritatively. When overlaying a
// live store task onto a server snapshot we copy exactly these (so the snapshot's
// server-only enrichment — origin_session, session_count, etc. — is preserved).
const LIVE_TASK_FIELDS = ["status", "priority", "title", "assignee", "labels", "execution_status", "description", "updated_at"] as const;

/**
 * Overlay live store tasks onto a server-query snapshot (e.g. plan.tasks), so a
 * view bound to the snapshot reflects optimistic edits immediately. Keeps the
 * snapshot's server-only fields, applies the store's authoritative raw fields,
 * and re-derives assignee_info from the live roster. Returns the snapshot row
 * unchanged (same reference) when nothing diverges, to preserve memoization.
 */
export function mergeLiveTasks(
  snapshotTasks: any[] | null | undefined,
  storeTasks: Record<string, any>,
  teamMembers?: Member[] | null,
  currentUser?: Member | null,
): any[] {
  if (!Array.isArray(snapshotTasks)) return snapshotTasks as any;
  return snapshotTasks.map((t) => {
    const live = storeTasks[t._id];
    const assignee = live ? live.assignee : t.assignee;
    const assignee_info = resolveAssigneeInfo(assignee, t.assignee_info, teamMembers, currentUser);
    let changed = !sameAssigneeInfo(assignee_info, t.assignee_info);
    const merged: any = { ...t };
    if (live) {
      for (const f of LIVE_TASK_FIELDS) {
        if (live[f] !== undefined && live[f] !== t[f]) { merged[f] = live[f]; changed = true; }
      }
    }
    merged.assignee_info = assignee_info;
    return changed ? merged : t;
  });
}

function sameAssigneeInfo(a: AssigneeInfo, b: any): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.image === b.image && a.github_username === b.github_username;
}

/**
 * A plan-mode doc's list title is its content's first markdown heading (the
 * server parses it into display_title). Re-derive it on an optimistic content
 * edit so the sidebar/doc list update instantly. Returns undefined when there's
 * no heading (the list then falls back to doc.title, matching the server).
 * Unlike the object derived-fields above, display_title is a string, so it
 * reconciles cleanly under the store's === field-protection — safe to store.
 */
export function deriveDocDisplayTitle(doc: { source?: string; content?: string } | null | undefined): string | undefined {
  if (!doc || doc.source !== "plan_mode" || !doc.content) return undefined;
  const m = doc.content.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : undefined;
}
