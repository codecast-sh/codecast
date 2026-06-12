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
 * Is this cached session a TEAMMATE's (injected by viewing/searching), not the
 * current user's own? The ownership signal is split across the session row and
 * the conversation meta, and either may be missing — a thin injected row can
 * carry no user_id at all while conversations[id].is_own (the access resolver's
 * verdict, written on every view) knows the truth. Every consumer that needs
 * ownership (author chip, stash/kill semantics) MUST resolve through here;
 * checking session.user_id alone misses exactly those thin rows.
 *
 * Precedence: conv.is_own (definitive) → user_id vs me → source-provided
 * author_name (team sources null it for own sessions) → assume mine.
 */
export function isForeignSession(
  session: { user_id?: string; author_name?: string | null },
  conv: { user_id?: string; is_own?: boolean } | null | undefined,
  myId: string | null | undefined,
): boolean {
  if (conv?.is_own === true) return false;
  if (conv?.is_own === false) return true;
  const uid = session.user_id ?? conv?.user_id;
  if (uid && myId) return uid !== myId;
  return !!session.author_name; // no ownership signal (or "me" unknown) → assume mine
}

/**
 * Resolve the author of an inbox session FOR DISPLAY — or null when the session
 * is the current user's own (or the author can't be named). The inbox session
 * cache is user-scoped, so a teammate's session only enters it by being OPENED
 * (deep-link / search / command-palette). Author identity therefore lives in two
 * places, and either may be missing:
 *   - the session row: `user_id` (server rows + fresh injections) and the
 *     source-provided `author_name`/`author_avatar` (search/recent results, which
 *     null those out for own sessions);
 *   - the conversation meta (`conversations[id]`, written on every view by the
 *     access resolver + getConversationWithMeta): `is_own` (definitive ownership),
 *     `user_id`, and `user.{name,avatar_url}`. This is what rescues rows injected
 *     BEFORE author enrichment existed — injection is skipped for already-cached
 *     rows, so the never-prune session row alone can stay author-less forever.
 *
 * Ownership precedence: conv.is_own (resolver verdict) → user_id vs currentUser →
 * source-provided author_name (team sources exclude own sessions) → assume mine.
 * Display precedence: live roster by user_id (instant rename/avatar) → session
 * author fields → conversation meta user. Returns null over a raw id when the
 * author can't be named, and never labels your own row before `currentUser`
 * loads (an own synced row carries no author_name/is_own:false to mislead it).
 */
export function resolveSessionAuthor(
  session: { user_id?: string; author_name?: string | null; author_avatar?: string | null },
  conv: { user_id?: string; is_own?: boolean; user?: { name?: string | null; email?: string | null; avatar_url?: string | null } | null } | null | undefined,
  currentUser: Member | null | undefined,
  teamMembers: Member[] | null | undefined,
): SessionAuthor {
  const uid = session.user_id ?? conv?.user_id;
  if (!isForeignSession(session, conv, currentUser?._id)) return null;

  // Display: live roster first (instant rename/avatar), then source fields, then meta.
  const m = uid ? teamMembers?.find((x) => x && x._id === uid) : null;
  if (m) return { name: m.name || m.email || "Unknown", avatar: m.image || m.github_avatar_url };
  const name = session.author_name ?? conv?.user?.name ?? conv?.user?.email ?? null;
  if (name) return { name, avatar: session.author_avatar ?? conv?.user?.avatar_url ?? null };
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
