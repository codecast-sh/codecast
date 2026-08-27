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
 * What we call a person. ONE rule, so a teammate with a GitHub handle and no
 * display name is not "sarah" in chat and "sarah@example.com" on every task and
 * doc chip. Chat's lib/chatViews calls this too.
 */
export function memberDisplayName(m: Member | null | undefined, fallback = "Unknown"): string {
  return m?.name || m?.github_username || m?.email || fallback;
}

/** Their face: an uploaded image, else whatever GitHub has. */
export function memberAvatarUrl(m: Member | null | undefined): string | undefined {
  return m?.image || m?.github_avatar_url;
}

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
  if (m) return { name: memberDisplayName(m), image: memberAvatarUrl(m), github_username: m.github_username };
  if (currentUser && (assignee === currentUser._id || assignee === "me")) {
    return { name: memberDisplayName(currentUser), image: memberAvatarUrl(currentUser), github_username: currentUser.github_username };
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
 * Precedence: conv.is_own true / session owned_by_me / owner match (any positive
 * ownership signal wins — a session ASSIGNED to me is mine to triage even though
 * another account runs it) → conv.is_own false → user_id vs me → source-provided
 * author_name (team sources null it for own sessions) → assume mine.
 *
 * owned_by_me outranks a NEGATIVE is_own verdict deliberately: is_own is stamped
 * on view, owned_by_me on every inbox delivery — after "assign to me" the meta
 * from a pre-assignment view is stale exactly when the flag is fresh.
 */
export function isForeignSession(
  session: { user_id?: string; author_name?: string | null; owned_by_me?: boolean; owner_user_id?: string | null },
  conv: { user_id?: string; is_own?: boolean } | null | undefined,
  myId: string | null | undefined,
): boolean {
  if (conv?.is_own === true) return false;
  if (session.owned_by_me) return false;
  if (myId && session.owner_user_id && session.owner_user_id === myId) return false;
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
  session: { user_id?: string; author_name?: string | null; author_avatar?: string | null; acting_user_id?: string | null },
  conv: { user_id?: string; is_own?: boolean; acting_user_id?: string | null; user?: { name?: string | null; email?: string | null; avatar_url?: string | null } | null } | null | undefined,
  currentUser: Member | null | undefined,
  teamMembers: Member[] | null | undefined,
): SessionAuthor {
  const uid = session.user_id ?? conv?.user_id;
  // An anchor renders under its bot identity (acting_user_id) even when it is the
  // current user's OWN session — so resolve that BEFORE the own-session short
  // circuit. Team bots are in the roster; a personal bot isn't, but the server
  // already stamped author_name/avatar with the bot, so fall back to those.
  const actingId = session.acting_user_id ?? conv?.acting_user_id;
  if (actingId) {
    const bot = teamMembers?.find((x) => x && x._id === actingId);
    if (bot) return { name: bot.name || bot.email || "Anchor", avatar: bot.image || bot.github_avatar_url };
    if (session.author_name) return { name: session.author_name, avatar: session.author_avatar ?? null };
  }
  // Authorship, not steering rights: a second-party-owned session is "mine"
  // per conv.is_own (the owner steers it like their own) but still RUN by
  // another account — the chip must name the runner. A known user_id decides;
  // only thin rows with no uid fall back to the is_own verdict.
  const foreignAuthor = uid && currentUser?._id
    ? uid !== currentUser._id
    : isForeignSession(session, conv, currentUser?._id);
  if (!foreignAuthor) return null;

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

/**
 * The conversation ids a task points at, origin first, deduplicated. The origin
 * (created_from_conversation) is usually also the first conversation_id, but a
 * task adopted by a later session lists that session too.
 */
export function taskLinkedConversationIds(
  task: { created_from_conversation?: string | null; conversation_ids?: string[] | null } | null | undefined,
): string[] {
  if (!task) return [];
  const out: string[] = [];
  for (const id of [task.created_from_conversation, ...(task.conversation_ids ?? [])]) {
    if (id && !out.includes(String(id))) out.push(String(id));
  }
  return out;
}

/**
 * A task's linked sessions, from what the client already knows. The server's
 * `linked_conversations` join rides only the detail query (one round-trip per
 * cold open), but the sessions those ids name are usually in the store already
 * — the inbox syncs them — and the list sync fetches an origin badge for every
 * task's source conversation. Build the same row shape from those so the
 * "Created from" chip and the Sessions list paint on the first frame; the
 * detail snapshot, once cached, wins (it carries the insight enrichment).
 */
export function resolveTaskLinkedConversations(
  task: { linked_conversations?: any[]; created_from_conversation?: string | null; conversation_ids?: string[] | null } | null | undefined,
  sessions: Record<string, any> | null | undefined,
  originBadges: Record<string, any> | null | undefined,
): any[] {
  if (!task) return [];
  if (Array.isArray(task.linked_conversations)) return task.linked_conversations;
  const out: any[] = [];
  for (const id of taskLinkedConversationIds(task)) {
    const row = sessions?.[id];
    const badge = originBadges?.[id];
    if (!row && !badge) continue;
    out.push({
      _id: id,
      session_id: row?.session_id ?? badge?.session_id ?? id,
      title: row?.title ?? row?.subtitle ?? badge?.title,
      project_path: row?.project_path,
      message_count: row?.message_count ?? badge?.message_count ?? 0,
      is_active: row ? row.is_idle === false : false,
      started_at: row?.started_at,
      updated_at: row?.updated_at ?? badge?.last_message_at,
      agent_type: row?.agent_type ?? badge?.agent_type,
      git_branch: row?.git_branch,
    });
  }
  return out;
}

/**
 * The docs a task's origin session produced, from the store's doc list when
 * the detail snapshot (`related_docs`) hasn't been cached yet. Same filter as
 * the server: the origin conversation's docs, archived ones excluded.
 */
export function resolveTaskRelatedDocs(
  task: { related_docs?: any[]; created_from_conversation?: string | null } | null | undefined,
  docs: Record<string, any> | null | undefined,
): any[] {
  if (!task) return [];
  if (Array.isArray(task.related_docs)) return task.related_docs;
  const origin = task.created_from_conversation;
  if (!origin || !docs) return [];
  const out: any[] = [];
  for (const id in docs) {
    const d = docs[id];
    if (d && d.conversation_id === origin && !d.archived_at) {
      out.push({ _id: d._id, title: d.display_title ?? d.title, doc_type: d.doc_type, source: d.source, created_at: d.created_at });
    }
  }
  return out.sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
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

/**
 * Client-side searchable text for a doc. A doc synced from a `.md` file is titled
 * from its first heading, not its filename — so without this, a doc backed by
 * `backend/ROADMAP_EXPLAINED.md` can't be found by typing its path or filename.
 * We fold the source file path into the search text; since the full path contains
 * the basename, both "ROADMAP_EXPLAINED.md" and "backend/ROADMAP_EXPLAINED.md"
 * match as substrings.
 */
export function docSearchText(
  doc: { display_title?: string; title?: string; source_file?: string | null } | null | undefined,
): string {
  if (!doc) return "";
  return [doc.display_title, doc.title, doc.source_file].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Resolving a reference from what the client already knows
//
// An inline object reference (an EntityIdPill) shows the object's TITLE. The
// title comes from a live Convex query, which takes a round-trip — and until it
// lands the pill can only show the id, so every task/plan mention in a
// conversation visibly flips from "ct-38940" to its name on mount.
//
// The client usually knows the answer already: the mention index holds a
// lightweight snapshot of every task/plan/doc the user can reference (across
// ALL their teams — that is what it is for), and the active-team collections
// hold the full rows. Seeding the pill from those makes it correct on the first
// frame, which is what local-first means here. The query still runs and still
// wins once it answers.
// ---------------------------------------------------------------------------

export type StoreEntitySeed = {
  _id?: string;
  title?: string;
  display_title?: string;
  name?: string;
  short_id?: string;
  status?: string;
};

// short_id → row, memoized on the COLLECTION's identity. The store is a
// mutative draft, so a collection keeps its reference until one of its rows
// changes; the index is therefore built once per version and shared by every
// pill on screen, instead of each one scanning thousands of rows.
const shortIdIndexes = new WeakMap<object, Map<string, any>>();

function byShortId(collection: Record<string, any> | undefined | null): Map<string, any> | null {
  if (!collection) return null;
  const cached = shortIdIndexes.get(collection);
  if (cached) return cached;
  const index = new Map<string, any>();
  for (const row of Object.values(collection)) {
    const sid = (row as any)?.short_id;
    if (typeof sid === "string") index.set(sid.toLowerCase(), row);
  }
  shortIdIndexes.set(collection, index);
  return index;
}

/** Look an id up in a collection by Convex id first, then by short id. */
function lookup(collection: Record<string, any> | undefined | null, rawId: string): any {
  if (!collection) return undefined;
  return collection[rawId] ?? byShortId(collection)?.get(rawId.toLowerCase());
}

/**
 * The object a reference names, as the local store already knows it — or
 * undefined when the client has never seen it. Sessions resolve by their 7-char
 * short id as well as their Convex id; triggers are not a store collection, so
 * they always wait for the server.
 */
export function findEntityInStore(
  state: any,
  type: string,
  rawId: string,
): StoreEntitySeed | undefined {
  if (!state || !rawId) return undefined;
  const mention = state.mentionIndex;
  switch (type) {
    case "task":
      return lookup(state.tasks, rawId) ?? lookup(mention?.tasks, rawId);
    case "plan":
      return lookup(state.plans, rawId) ?? lookup(mention?.plans, rawId);
    case "doc":
      return lookup(state.docs, rawId) ?? lookup(mention?.docs, rawId);
    case "project":
      return lookup(state.projects, rawId);
    case "session": {
      const short = rawId.slice(0, 7).toLowerCase();
      return (
        state.conversations?.[rawId]
        ?? state.sessions?.[rawId]
        ?? lookup(state.conversations, short)
        ?? lookup(state.sessions, short)
      );
    }
    default:
      return undefined;
  }
}
