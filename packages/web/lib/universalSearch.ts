// Search across the objects the local store already holds, the instant tier
// of every search surface (web's Cmd-K palette, the phone's search). Server
// search lands on top of it (hooks/useRemoteSearch).

import { collapseSameTitle, matchScore, matchScoreLower, textWords } from "./mentionRanking";
import { inActiveWorkspace } from "./workspaceScope";
import { isActiveTask, isOnHumanBoard } from "@codecast/shared/tasks";

// One matcher for tasks/docs/plans over the globally-synced mention index.
// Reuses matchScore() (exact > prefix > substring, every typed word required
// in any order) with a short_id fallback, and
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
// One entry per record object: an index rebuilt after one task changed
// lowers only that task's fields again.
const _entries = new WeakMap<object, Entry>();
function entryOf(rec: MentionRecord): Entry {
  let entry = _entries.get(rec);
  if (!entry) {
    // File-synced docs are titled from their content heading, not their
    // filename; the source file's basename and full path match too.
    const path = rec.source_file ? rec.source_file.toLowerCase() : null;
    entry = { rec, title: (rec.title || "").toLowerCase(), goal: rec.goal ? rec.goal.toLowerCase() : null, path, base: path ? path.split("/").pop() || path : null, shortId: rec.short_id ? rec.short_id.toLowerCase() : null };
    _entries.set(rec, entry);
  }
  return entry;
}
// The records a scope can show (its workspace, less the caller's exclusions),
// listed once per records object rather than filtered again on every key,
// with the last query's hits for narrowing.
// A record as the matcher reads it: its searchable fields lowered once, when
// its scope is first listed, rather than on every key.
type Entry = { rec: MentionRecord; title: string; goal: string | null; path: string | null; base: string | null; shortId: string | null };
// The records a scope can show (its workspace, less the caller's exclusions),
// listed once per records object rather than filtered again on every key,
// with the last query's hits for narrowing.
type Scoped = { rows: Entry[]; last?: { q: string; hits: Entry[] } };
const _scoped = new WeakMap<object, Map<unknown, Map<string, Scoped>>>();
function scopedRecords(records: Record<string, MentionRecord>, teamId: string | undefined, exclude?: (r: MentionRecord) => boolean): Scoped {
  let byExclude = _scoped.get(records);
  if (!byExclude) _scoped.set(records, (byExclude = new Map()));
  let byTeam = byExclude.get(exclude);
  if (!byTeam) byExclude.set(exclude, (byTeam = new Map()));
  let scope = byTeam.get(teamId ?? "");
  if (!scope) {
    const rows: Entry[] = [];
    for (const rec of Object.values(records)) if (!exclude?.(rec) && inActiveWorkspace(rec, teamId)) rows.push(entryOf(rec));
    byTeam.set(teamId ?? "", (scope = { rows }));
  }
  return scope;
}

/** `items` in `before` order, produced lazily from a heap: a caller that
 *  stops after a few (a capped, deduplicated list) never sorts the rest. */
function* inOrder<T>(items: T[], before: (a: T, b: T) => boolean): Generator<T> {
  const h = items;
  const down = (i: number, n: number) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && before(h[l], h[m])) m = l;
      if (r < n && before(h[r], h[m])) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  };
  for (let i = (h.length >> 1) - 1; i >= 0; i--) down(i, h.length);
  for (let n = h.length; n > 0; n--) {
    yield h[0];
    h[0] = h[n - 1];
    down(0, n - 1);
  }
}

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
  const scope = scopedRecords(records, teamId, exclude);
  // Every hit for "plan r" is a hit for "plan": a query that extends the last
  // one searches only the last one's hits.
  const rows = q && scope.last && q.startsWith(scope.last.q) ? scope.last.hits : scope.rows;
  const hits: Entry[] = [];
  const ranked: Array<{ rec: MentionRecord; rank: number; i: number }> = [];
  for (const e of rows) {
    if (!q) { ranked.push({ rec: e.rec, rank: 0, i: ranked.length }); continue; }
    const titleRank = matchScoreLower(e.title, q);
    const goalRank = e.goal ? matchScoreLower(e.goal, q) : Infinity;
    // The basename is the strong prefix match; the full path matches "dir/file.md".
    const fileRank = e.path ? Math.min(matchScoreLower(e.base!, q), matchScoreLower(e.path, q)) : Infinity;
    let rank = Math.min(titleRank, goalRank, fileRank);
    if (rank === Infinity) {
      if (!e.shortId?.includes(q)) continue;
      rank = 50; // short_id-only hit ranks below any title/goal hit
    }
    hits.push(e);
    ranked.push({ rec: e.rec, rank, i: ranked.length });
  }
  if (q) scope.last = { q, hits };
  // Collapse same-title records to one row. Workflow-generated tasks/plans often
  // share an identical title across many distinct ids/statuses (e.g. a "Verify
  // task list covers entire plan" task minted every run), which floods the
  // palette with apparent dupes. Best first, so the first occurrence per title
  // is the highest-ranked, most-recent representative; only as many as that
  // takes are ever ordered.
  type Ranked = (typeof ranked)[number];
  const before = (a: Ranked, b: Ranked) =>
    a.rank !== b.rank ? a.rank < b.rank : (a.rec.updated_at || 0) !== (b.rec.updated_at || 0) ? (a.rec.updated_at || 0) > (b.rec.updated_at || 0) : a.i < b.i;
  return collapseSameTitle((function* () { for (const r of inOrder(ranked, before)) yield r.rec; })(), (rec) => rec.title, cap);
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
  const idx = s.mentionIndex ?? { tasks: {}, docs: {}, plans: {} };
  // Each kind is rebuilt only when its two homes changed, and keeps its object
  // otherwise, so the matchers' per-object caches (scopedRecords) hold across
  // palette opens.
  return {
    // Only real work: no suggestion waiting on triage, no unpromoted insight
    // (the store holds both; the boards never show them).
    tasks: mergedById("tasks", idx.tasks, s.tasks, (t: any) => isActiveTask(t)),
    docs: mergedById("docs", idx.docs, s.docs),
    plans: mergedById("plans", idx.plans, s.plans),
  };
}

const _merged = new Map<string, { index: unknown; store: unknown; byId: Record<string, any> }>();
function mergedById(kind: string, index: Record<string, any> | undefined, store: Record<string, any> | undefined, keep?: (row: any) => boolean): Record<string, any> {
  const hit = _merged.get(kind);
  if (hit && hit.index === index && hit.store === store) return hit.byId;
  const byId: Record<string, any> = {};
  for (const row of mergeEntityRows(index, store)) if (!keep || keep(row)) byId[String(row._id)] = row;
  _merged.set(kind, { index, store, byId });
  return byId;
}

/** The search index as the everyday surfaces see it: every scope's notes and
 *  plans, and only the to-dos the human's board shows. */
export function humanSearchIndex(s: Parameters<typeof searchIndexOf>[0]): ReturnType<typeof searchIndexOf> {
  const all = searchIndexOf(s);
  return { ...all, tasks: Object.fromEntries(Object.entries(all.tasks).filter(([, t]) => isOnHumanBoard(t as any))) };
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
// Module-level, so each exclusion is one function and its scoped rows cache.
const droppedTask = (t: MentionRecord) => t.status === "dropped";
const planDoc = (d: MentionRecord) => d.doc_type === "plan";
const abandonedPlan = (p: MentionRecord) => p.status === "abandoned";

/** Lists each kind's scope (scopedRecords) ahead of the first typed key, for
 *  an idle moment after the palette opens. */
export function warmMentionGroups(index: { tasks: Record<string, any>; docs: Record<string, any>; plans: Record<string, any> }, teamId: string | undefined): void {
  scopedRecords(index.tasks, teamId, droppedTask);
  scopedRecords(index.docs, teamId, planDoc);
  scopedRecords(index.plans, teamId, abandonedPlan);
}

export function matchMentionGroups(
  index: { tasks: Record<string, any>; docs: Record<string, any>; plans: Record<string, any> },
  query: string,
  teamId: string | undefined,
  cap: number,
  browse: { task?: boolean; doc?: boolean; plan?: boolean } = {},
): { tasks: MentionRecord[]; docs: MentionRecord[]; plans: MentionRecord[] } {
  const kind = kindOfQuery(query);
  return {
    tasks: withKindRows(matchEntities(index.tasks, query, teamId, cap, droppedTask, browse.task), () => matchEntities(index.tasks, "", teamId, cap, droppedTask, true), kind === "task", cap),
    docs: withKindRows(matchEntities(index.docs, query, teamId, cap, planDoc, browse.doc), () => matchEntities(index.docs, "", teamId, cap, planDoc, true), kind === "doc", cap),
    plans: matchEntities(index.plans, query, teamId, cap, abandonedPlan, browse.plan),
  };
}

/** Routines a query names, best first: by title or instruction, else by
 *  short id; ended routines left out. Queries under two characters match
 *  nothing, and a query that is the kind's word ("routines") lists them all,
 *  newest first, after any title hit. The palette and the search page read
 *  this one matcher. */
const _routineHits = new WeakMap<object, { q: string; hits: readonly unknown[] }>();
// The routines that have not ended, listed once per rows array.
const _activeRoutines = new WeakMap<object, readonly unknown[]>();
function activeRoutines<T extends { status?: string }>(rows: readonly T[]): readonly T[] {
  let active = _activeRoutines.get(rows) as readonly T[] | undefined;
  if (!active) _activeRoutines.set(rows, (active = rows.filter((t) => t.status !== "completed" && t.status !== "cancelled")));
  return active;
}
type LoweredRoutine = { title: string; prompt: string; promptWords?: string[] };
const _routineLower = new WeakMap<object, LoweredRoutine>();
function loweredRoutine(t: { title?: string; prompt?: string }): LoweredRoutine {
  let hit = _routineLower.get(t);
  if (!hit) _routineLower.set(t, (hit = { title: (t.title || "").toLowerCase(), prompt: (t.prompt || "").toLowerCase() }));
  return hit;
}
function hasAll(lower: string, tokens: string[]): boolean {
  for (const tok of tokens) if (!lower.includes(tok)) return false;
  return true;
}

export function matchRoutines<T extends { title?: string; prompt?: string; short_id?: string; status?: string; updated_at?: number; _creationTime?: number }>(rows: readonly T[], query: string, cap: number): T[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const listAll = kindOfQuery(q) === "routine";
  // A query that extends the last one over the same rows searches only the
  // last one's hits, unless it lists every routine.
  const last = _routineHits.get(rows);
  const scan = !listAll && last && q.startsWith(last.q) ? (last.hits as T[]) : activeRoutines(rows);
  const hits: T[] = [];
  const ranked: Array<{ t: T; rank: number }> = [];
  const tokens = q.split(/\s+/);
  for (const t of scan) {
    // matchScore is finite only when every typed word is inside the text, so
    // a row whose title and prompt each lack one is out before either long
    // text is lowered and split again.
    const lower = loweredRoutine(t);
    let rank = Infinity;
    if (hasAll(lower.title, tokens)) rank = matchScoreLower(lower.title, q);
    if (hasAll(lower.prompt, tokens)) rank = Math.min(rank, matchScoreLower(lower.prompt, q, () => (lower.promptWords ??= textWords(lower.prompt))));
    if (rank === Infinity) {
      if (t.short_id?.toLowerCase().includes(q)) rank = 50;
      else if (listAll) rank = 100;
      else continue;
    }
    hits.push(t);
    ranked.push({ t, rank });
  }
  _routineHits.set(rows, { q, hits });
  ranked.sort((a, b) => a.rank - b.rank || (b.t.updated_at || b.t._creationTime || 0) - (a.t.updated_at || a.t._creationTime || 0));
  return ranked.slice(0, cap).map((r) => r.t);
}

/** Rows a query names by any of their words, best first, capped: each row's
 *  rank is its best field (matchScore: every typed word, in any order), the
 *  newest wins a tie. The org's objects and published pages are few, so a
 *  scan of the store's rows answers them as the person types. */
export function matchRows<T>(rows: readonly T[], query: string, fields: (row: T) => Array<string | null | undefined>, cap: number, at: (row: T) => number = () => 0): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: Array<{ row: T; rank: number }> = [];
  for (const row of rows) {
    let rank = Infinity;
    for (const f of fields(row)) if (f) rank = Math.min(rank, matchScore(f, q));
    if (rank !== Infinity) ranked.push({ row, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || at(b.row) - at(a.row));
  return ranked.slice(0, cap).map((r) => r.row);
}

/** Projects by title or short id. */
export function matchProjects<T extends { title?: string; short_id?: string; updated_at?: number }>(rows: readonly T[], query: string, cap: number): T[] {
  return matchRows(rows, query, (p) => [p.title, p.short_id], cap, (p) => p.updated_at ?? 0);
}

/** Goals by title or short id; a dropped goal is not offered. */
export function matchGoals<T extends { title?: string; short_id?: string; status?: string; updated_at?: number }>(rows: readonly T[], query: string, cap: number): T[] {
  return matchRows(rows.filter((g) => g.short_id && g.status !== "dropped"), query, (g) => [g.title, g.short_id], cap, (g) => g.updated_at ?? 0);
}

/** Roles by name, `@handle` as written, or short id; a retired role is not offered. */
export function matchRoles<T extends { name?: string; handle?: string; short_id?: string; status?: string }>(rows: readonly T[], query: string, cap: number): T[] {
  return matchRows(rows.filter((r) => r.status !== "retired"), query.trim().replace(/^@/, ""), (r) => [r.name, r.handle, r.short_id], cap);
}
