// Search across the objects the local store already holds, the instant tier
// of every search surface (web's Cmd-K palette, the phone's search). Server
// search lands on top of it (hooks/useRemoteSearch).

import { collapseSameTitle, score } from "./mentionRanking";
import { inActiveWorkspace } from "./workspaceScope";
import { isActiveTask, isOnHumanBoard } from "@codecast/shared/tasks";
import { isOnNotesShelf } from "@codecast/shared/docs";
import { inAssistantScope, isAssistantDoc, isAssistantTask } from "./assistantScope";

// One matcher for tasks/docs/plans over the globally-synced mention index.
// Reuses score() (exact > prefix > substring) with a short_id fallback, and
// mirrors the Tasks/Docs pages' team scoping: in a team view keep this team's
// items plus teamless orphans; in the personal view keep only teamless items.
export type MentionRecord = {
  _id: string;
  title: string;
  short_id?: string;
  goal?: string;
  doc_type?: string;
  source_file?: string | null;
  status?: string;
  updated_at?: number;
  team_id?: string | null;
};
export function matchEntities(
  records: Record<string, MentionRecord>,
  query: string,
  teamId: string | undefined,
  cap: number,
  exclude?: (r: MentionRecord) => boolean,
  // With no query, list the most recent records instead of nothing (pick mode
  // browses; the root palette stays session-focused when empty).
  browseWhenEmpty = false,
): MentionRecord[] {
  const q = query.trim().toLowerCase();
  if (!q && !browseWhenEmpty) return [];
  const ranked: Array<{ rec: MentionRecord; rank: number }> = [];
  for (const rec of Object.values(records)) {
    if (exclude?.(rec)) continue;
    if (!inActiveWorkspace(rec, teamId)) continue;
    if (!q) { ranked.push({ rec, rank: 0 }); continue; }
    const titleRank = score(rec.title || "", q);
    const goalRank = rec.goal ? score(rec.goal, q) : Infinity;
    // File-synced docs are titled from their content heading, not their filename;
    // score the source file too so a doc is findable by name/path. Score the
    // basename (strong prefix match) and the full path (matches "dir/file.md").
    let fileRank = Infinity;
    if (rec.source_file) {
      const path = rec.source_file.toLowerCase();
      const base = path.split("/").pop() || path;
      fileRank = Math.min(score(base, q), score(path, q));
    }
    let rank = Math.min(titleRank, goalRank, fileRank);
    if (rank === Infinity) {
      if (!rec.short_id?.toLowerCase().includes(q)) continue;
      rank = 50; // short_id-only hit ranks below any title/goal hit
    }
    ranked.push({ rec, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || (b.rec.updated_at || 0) - (a.rec.updated_at || 0));
  // Collapse same-title records to one row. Workflow-generated tasks/plans often
  // share an identical title across many distinct ids/statuses (e.g. a "Verify
  // task list covers entire plan" task minted every run), which floods the
  // palette with apparent dupes. Sorted best-first, so the first occurrence per
  // title is the highest-ranked, most-recent representative.
  return collapseSameTitle(ranked.map((r) => r.rec), (rec) => rec.title, cap);
}

/** The mention index's rows with the store's own collections laid over
 *  them, by id. The index is a cross-team sample capped per team, so a
 *  person's own to-dos and notes can be missing from it; the store's
 *  collections hold them for the open workspace (local-first). Rows without a
 *  title are left out. */
export function mergeEntityRows<T extends { _id?: unknown; title?: unknown }>(indexRows: Record<string, T> | undefined, storeRows: Record<string, T> | undefined): T[] {
  const rows = new Map<string, T>();
  for (const row of Object.values(indexRows ?? {})) if (row?._id) rows.set(String(row._id), row);
  for (const row of Object.values(storeRows ?? {})) if (row?._id && row.title) rows.set(String(row._id), row);
  return [...rows.values()];
}

/** A search index over both homes (mergeEntityRows), keyed by id, in the
 *  shape matchMentionGroups reads. */
export function searchIndexOf(s: {
  mentionIndex?: { tasks: Record<string, any>; docs: Record<string, any>; plans: Record<string, any> } | null;
  tasks?: Record<string, any>; docs?: Record<string, any>; plans?: Record<string, any>;
}): { tasks: Record<string, MentionRecord>; docs: Record<string, MentionRecord>; plans: Record<string, MentionRecord> } {
  const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [String(r._id), r]));
  const idx = s.mentionIndex ?? { tasks: {}, docs: {}, plans: {} };
  return {
    // Only real work: no suggestion waiting on triage, no unpromoted insight
    // (the store holds both; the boards never show them).
    tasks: byId(mergeEntityRows(idx.tasks, s.tasks).filter((t: any) => isActiveTask(t))),
    docs: byId(mergeEntityRows(idx.docs, s.docs)),
    plans: byId(mergeEntityRows(idx.plans, s.plans)),
  };
}

/** The search index as hosted mode's Assistant scope sees it: the to-dos and
 *  notes the To-dos and Notes pages list on their Assistant tab, and no
 *  plans. Read from the store's own rows, since the mention index's slim
 *  rows carry no project or conversation to judge a row by (an engineering
 *  task there would pass as the person's own). The palette and /search read
 *  this one rule, so they agree with the pages. */
export function assistantSearchIndex(s: {
  tasks?: Record<string, any>; docs?: Record<string, any>; sessions?: Record<string, { agent_type?: string | null } | undefined>;
}): { tasks: Record<string, MentionRecord>; docs: Record<string, MentionRecord>; plans: Record<string, MentionRecord> } {
  const sessions = s.sessions ?? {};
  const assistantConversations = new Set(Object.keys(sessions).filter((id) => inAssistantScope(sessions[id]?.agent_type)));
  const tasks = Object.values(s.tasks ?? {}).filter((t: any) => isActiveTask(t) && isOnHumanBoard(t) && isAssistantTask({
    ...t,
    source_agent_type: t.created_from_conversation ? sessions[String(t.created_from_conversation)]?.agent_type ?? null : null,
  }));
  const docs = Object.values(s.docs ?? {}).filter((d: any) => isOnNotesShelf(d) && isAssistantDoc(d, assistantConversations));
  const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [String(r._id), r]));
  return { tasks: byId(tasks), docs: byId(docs), plans: {} };
}

/** Open to-dos before closed ones, each kind keeping its rank. */
export function openTasksFirst<T extends { status?: string }>(rows: readonly T[]): T[] {
  const closed = (t: T) => t.status === "done" || t.status === "dropped";
  return [...rows.filter((t) => !closed(t)), ...rows.filter(closed)];
}

/** The kinds a query can name by their own word. */
export type SearchKind = "task" | "doc" | "routine";

const KIND_WORDS: Record<SearchKind, readonly string[]> = {
  task: ["to-do", "todo", "to do", "task"],
  doc: ["note", "doc", "document"],
  routine: ["routine", "schedule", "reminder", "trigger"],
};

/** The shortest start of a kind word that names the kind ("rou", "not"),
 *  so the list shows while the word is still being typed. */
const KIND_PREFIX_MIN = 3;

/** The kind a query names by its word, its plural or a start of it of
 *  KIND_PREFIX_MIN letters or more ("routines", "to-d", "rou"), or null. A
 *  person who types the kind of thing they want is asking to see their
 *  things of that kind. */
export function kindOfQuery(query: string): SearchKind | null {
  const q = query.trim().toLowerCase().replace(/s$/, "");
  if (!q) return null;
  for (const kind of Object.keys(KIND_WORDS) as SearchKind[]) if (KIND_WORDS[kind].includes(q)) return kind;
  if (q.length < KIND_PREFIX_MIN) return null;
  for (const kind of Object.keys(KIND_WORDS) as SearchKind[]) if (KIND_WORDS[kind].some((w) => w.startsWith(q))) return kind;
  return null;
}

/** A query that names `kind` lists that kind: its title hits first, then the
 *  rest, newest first, up to `cap`. Any other query keeps its hits. */
function withKindRows<T extends { _id?: unknown }>(hits: T[], listed: () => T[], named: boolean, cap: number): T[] {
  if (!named) return hits;
  const seen = new Set(hits.map((r) => String(r._id)));
  return [...hits, ...listed().filter((r) => !seen.has(String(r._id)))].slice(0, cap);
}

/** Tasks, plans and docs a query names, each ranked and capped, as every
 *  search surface groups them: dropped tasks, abandoned plans and plan-type
 *  docs left out. A query that is a kind's word ("notes") lists that kind. */
export function matchMentionGroups(
  index: { tasks: Record<string, any>; docs: Record<string, any>; plans: Record<string, any> },
  query: string,
  teamId: string | undefined,
  cap: number,
  browse: { task?: boolean; doc?: boolean; plan?: boolean } = {},
): { tasks: MentionRecord[]; docs: MentionRecord[]; plans: MentionRecord[] } {
  const kind = kindOfQuery(query);
  const dropped = (t: MentionRecord) => t.status === "dropped";
  const planDoc = (d: MentionRecord) => d.doc_type === "plan";
  return {
    tasks: withKindRows(matchEntities(index.tasks, query, teamId, cap, dropped, browse.task), () => matchEntities(index.tasks, "", teamId, cap, dropped, true), kind === "task", cap),
    docs: withKindRows(matchEntities(index.docs, query, teamId, cap, planDoc, browse.doc), () => matchEntities(index.docs, "", teamId, cap, planDoc, true), kind === "doc", cap),
    plans: matchEntities(index.plans, query, teamId, cap, (p) => p.status === "abandoned", browse.plan),
  };
}

/** Routines a query names, best first: by title or instruction, else by
 *  short id; ended routines left out. Queries under two characters match
 *  nothing, and a query that is the kind's word ("routines") lists them all,
 *  newest first, after any title hit. The palette and the search page read
 *  this one matcher. */
export function matchRoutines<T extends { title?: string; prompt?: string; short_id?: string; status?: string; updated_at?: number; _creationTime?: number }>(rows: readonly T[], query: string, cap: number): T[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const listAll = kindOfQuery(q) === "routine";
  const ranked: Array<{ t: T; rank: number }> = [];
  for (const t of rows) {
    if (t.status === "completed" || t.status === "cancelled") continue;
    let rank = Math.min(score(t.title || "", q), score(t.prompt || "", q));
    if (rank === Infinity) {
      if (t.short_id?.toLowerCase().includes(q)) rank = 50;
      else if (listAll) rank = 100;
      else continue;
    }
    ranked.push({ t, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || (b.t.updated_at || b.t._creationTime || 0) - (a.t.updated_at || a.t._creationTime || 0));
  return ranked.slice(0, cap).map((r) => r.t);
}
