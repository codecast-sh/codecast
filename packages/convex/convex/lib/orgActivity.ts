// Ground in what is happening, not in what was filed (docs/architecture/
// org-staffing.md S9). ONE reading of "where the work is" and "which records
// are stale", pure over rows so the analyzer inputs (orgInit.analysisInputs)
// and the health query (orgHealth) share it and a test needs no database.
//
// The commits table, read by repository over 30 days, says where code lands;
// the org scan's sessions say where agents work; the tasks and plans say what
// was filed. Where the filing and the evidence disagree — a plan whose tasks
// all closed, a task whose sessions are all done, a project nothing touches —
// this module names the record stale, and the analyzer proposes the sync
// (a plan_status / task_status / project_status change) before it proposes a
// seat.

import type { BoundRecord, LandedCommit, StalePlan, StaleProject, StaleTask, StaleWork } from "@codecast/shared/contracts/orgCapacity";

const D = 86_400_000;
export const STALE_PLAN_DAYS = 21;
export const STALE_TASK_DAYS = 14;
/** An open task nobody touched for this long, with no session on it in the window, is stale too: three Union tasks whose work landed in July sat open and unflagged because only in progress rows had a reason (2026-09-21). */
export const STALE_OPEN_DAYS = 45;
export const STALE_PROJECT_DAYS = 30;
export const DONE_STILL_WORKED_DAYS = 7;
export const ACTIVITY_WINDOW_DAYS = 30;

// A repo laid out as a monorepo hides the meaningful unit one level down:
// "packages/web/..." is the web package, not "packages". The top-level dir is
// the unit everywhere else.
const CONTAINER_DIRS = new Set(["packages", "apps", "services", "libs", "crates", "modules", "src"]);

/** The area a file path belongs to: its package in a monorepo, else its top
 *  directory. "" for a repo-root file (README.md); a file straight under a
 *  container dir (src/index.ts) belongs to the container. */
export function pathPrefixOf(filePath: string): string {
  const parts = (filePath ?? "").split("/").filter(Boolean);
  if (parts.length <= 1) return "";
  if (CONTAINER_DIRS.has(parts[0])) return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0];
  return parts[0];
}

/** The areas one commit lands on, from the files it touched: the deepest
 *  directory every file shares, reduced to the package or top level area it
 *  names. A commit whose files all sit under packages/web is one area; a
 *  commit that spans packages (the shared directory is a bare container, or
 *  the root) lands on each area it touched, because it is evidence for each
 *  seam. No file list means no area can be read: [] and the caller counts it
 *  as a commit without files. */
export const FILES_PER_COMMIT = 200;
export function commitAreaPrefixes(files: Array<{ filename: string }> | null | undefined, cap = FILES_PER_COMMIT): string[] {
  const names = (files ?? []).slice(0, cap).map((f) => f.filename).filter(Boolean);
  if (names.length === 0) return [];
  const prefixes = new Set(names.map(pathPrefixOf));
  if (prefixes.size === 1) return [prefixes.values().next().value as string];
  // The deepest shared directory, when it names an area, is the one answer;
  // when it is a container or the root, the commit spans areas.
  const split = names.map((n) => n.split("/").filter(Boolean).slice(0, -1));
  const shared: string[] = [];
  for (let i = 0; ; i++) {
    const seg = split[0]?.[i];
    if (seg === undefined || !split.every((p) => p[i] === seg)) break;
    shared.push(seg);
  }
  const sharedArea = shared.length ? pathPrefixOf(`${shared.join("/")}/x`) : "";
  if (sharedArea && !CONTAINER_DIRS.has(sharedArea)) return [sharedArea];
  return Array.from(prefixes).sort();
}

/** The area a filesystem path (a session's project_path) sits in, read as the
 *  tail after a container dir, so "/home/me/src/repo/packages/web" reads as
 *  "packages/web" and lines up with a commit's file prefix. */
export function projectPathPrefix(projectPath: string | null | undefined): string | null {
  const parts = (projectPath ?? "").split("/").filter(Boolean);
  // The deepest container wins: a checkout is ".../src/repo/packages/web", and
  // the package (packages/web) is the unit, not the repo root under src.
  for (let i = parts.length - 2; i >= 0; i--) {
    if (CONTAINER_DIRS.has(parts[i])) return `${parts[i]}/${parts[i + 1]}`;
  }
  return parts.length ? parts[parts.length - 1] : null;
}

/** The area a session works in, so it lands on the same row as the commits:
 *  its project path relative to its git root, reduced the way a commit's file
 *  is ("" at the root, "packages/web" inside a package). Without a git root
 *  the path's own tail is the best reading (projectPathPrefix). A session at
 *  the repository root and a commit with no file list then share the "" row
 *  for that repository instead of sitting under two different keys. */
export function sessionAreaPrefix(s: { project_path?: string | null; git_root?: string | null }): string | null {
  const path = (s.project_path ?? "").replace(/\/+$/, "");
  const root = (s.git_root ?? "").replace(/\/+$/, "");
  if (!path) return null;
  if (root && (path === root || path.startsWith(root + "/"))) {
    const rel = path.slice(root.length).replace(/^\/+/, "");
    return rel ? pathPrefixOf(`${rel}/x`) : "";
  }
  return projectPathPrefix(path);
}

export type ActivityCommit = {
  repository?: string | null;
  timestamp: number;
  author_name?: string | null;
  author_email?: string | null;
  files?: Array<{ filename: string }> | null;
  task_ids?: string[] | null;
  /** The ref a pushed commit landed on (bare name); absent for a commit read
   *  from a transcript, whose branch is not known. */
  branch?: string | null;
  /** The sha and the message's first line, so a landing can be named to the
   *  reader (landingFor); absent on a row read for its areas alone. */
  sha?: string | null;
  message?: string | null;
};

/** A commit is landed history only on the default branch. A transcript commit
 *  carries no branch and is taken as landed; a webhook commit on any other
 *  branch is work in flight (a branch ahead of main, an open pull request). */
export const isLandedCommit = (c: ActivityCommit) => !c.branch || c.branch === "main" || c.branch === "master";

export type ActivitySession = {
  _id: string;
  state: string;              // work_state from the org scan
  updated_at?: number | null; // the session's last touch, for the stale task clock
  owner_user_id?: string | null;
  project_path?: string | null;
  repo?: string | null;       // extractRepoFromRemoteUrl(git_remote_url) or repo from git_root
  git_root?: string | null;
  active_plan_id?: string | null;
  active_task_id?: string | null;
};

export type ActivityProject = { id: string; title: string; status: string; project_path?: string | null; updated_at: number };
/** `last_entry_at` is the newest entry on the plan's own timeline (a comment, a decision, a progress note): a word somebody wrote, where `updated_at` moves on any write, a bulk apply included. */
export type ActivityPlan = { id: string; short_id: string; title: string; status: string; project_id?: string | null; updated_at: number; last_entry_at?: number | null };
/** A plan row as the activity reading takes it, from the stored row: the one
 *  mapping the analyzer inputs and the health query share. */
export function activityPlanOf(p: any): ActivityPlan {
  const entries: Array<{ timestamp?: number }> = p.entries ?? [];
  return {
    id: String(p._id), short_id: p.short_id, title: p.title, status: p.status,
    project_id: p.project_id ? String(p.project_id) : null,
    updated_at: p.updated_at ?? p._creationTime,
    last_entry_at: entries.length ? Math.max(...entries.map((e) => e.timestamp ?? 0)) : null,
  };
}
export type ActivityTask = {
  id: string; short_id: string; title: string; status: string;
  plan_id?: string | null; project_id?: string | null; updated_at: number;
  conversation_ids?: string[] | null;
};
export type ActivityMember = { user_id: string; name: string; email?: string | null };

export type ActivityInputs = {
  now: number;
  commits: ActivityCommit[];
  sessions: ActivitySession[];
  projects: ActivityProject[];
  plans: ActivityPlan[];
  tasks: ActivityTask[];
  members: ActivityMember[];
  /** Cap the number of areas emitted, busiest first. */
  maxAreas?: number;
  /** Cap the files read from one commit when deriving its areas. */
  filesPerCommit?: number;
};

export type ActivityArea = {
  repository: string;
  path_prefix: string;
  commits_30d: number;
  authors: Array<{ name: string; commits: number }>;
  sessions_30d: number;
  project_id?: string;
  /** Set instead of project_id when the path the area's sessions run in is one several projects file under. */
  project_shared_by?: number;
};
export type ActivityPerson = {
  user_id: string;
  name: string;
  areas: Array<{ path_prefix: string; commits: number; sessions: number }>;
};
/** How much of the commit history carried a file list. A commit without one
 *  lands on the root prefix and reads as no seam; the analyzer reports the
 *  count as "could not verify" rather than as a finding about the root. */
export type ActivityCommitCoverage = { total: number; with_files: number; without_files: number; spanning_areas: number; /** On main, with a message: the rows a record's landing was searched in. */ landed: number };
export type OrgActivity = { areas: ActivityArea[]; people: ActivityPerson[]; stale: StaleWork; bound: { tasks: BoundRecord[]; plans: BoundRecord[] }; commits: ActivityCommitCoverage };

// ── Naming a record in free text ────────────────────────────────────────────
// A commit, a chat line or a session message names a record when it carries
// the record's short id, or two or more of the distinctive words of its title.
// One reading, shared by the landing join below, the work share of a long
// running session (orgInit) and the chat threads that name a project
// (orgInit signals), so every input matches the way the analyzer was told to
// search: `--grep=<its id, or two or three distinctive words of its title>`.
// Distinctive: four letters or more and not a word every title carries. One
// word alone is never a match: a title with one distinctive word ("Infra")
// matches only by its short id, because one word names half the log.
const RECORD_STOP_WORDS = new Set([
  "with", "from", "that", "this", "when", "then", "than", "into", "onto", "over", "under", "after", "before", "every",
  "each", "their", "there", "these", "those", "which", "while", "about", "what", "have", "will", "been", "were", "also",
  "only", "more", "most", "much", "many", "such", "very", "just", "make", "made", "take", "took", "uses", "used", "using",
  "does", "done", "doing", "should", "would", "could", "still", "again", "never", "always", "because", "where", "whose",
  "same", "other", "another", "some", "them", "they", "your", "ours", "here", "need", "needs", "want", "wants", "keep",
  "keeps", "gets", "goes", "went", "come", "back", "down", "next", "first", "last", "both", "through", "without", "within",
  "between", "across", "against", "instead", "rather", "whether", "either", "neither", "task", "tasks", "plan", "plans",
  "project", "projects", "work", "works", "fix", "fixes", "feat", "chore", "test", "tests", "code", "page", "pages",
  "file", "files", "data", "user", "users", "session", "sessions", "team", "teams", "part", "step", "steps", "thing",
  "things", "issue", "issues", "update", "updates", "change", "changes", "improve", "support", "handle", "handles",
  "check", "checks", "wire", "wires", "clean", "cleanup", "refactor", "review", "spec", "docs",
]);
const RECORD_WORD_MIN = 4;
const wordsOf = (text: string | null | undefined): string[] => (text ?? "").toLowerCase().match(/[a-z0-9][a-z0-9'-]*[a-z0-9]|[a-z0-9]/g) ?? [];
/** The distinctive words of a title, in order, deduped. */
export function recordWords(title: string | null | undefined): string[] {
  const out: string[] = [];
  for (const w of wordsOf(title)) { const word = w.replace(/'s$/, ""); if (word.length >= RECORD_WORD_MIN && !/^\d+$/.test(word) && !RECORD_STOP_WORDS.has(word) && !out.includes(word)) out.push(word); }
  return out;
}
export type RecordRef = { short_id?: string | null; title?: string | null };
/** A text prepared for matching many records: its short ids and its word set. */
export type NamedText = { ids: Set<string>; words: Set<string> };
export function namedTextOf(text: string | null | undefined): NamedText {
  const lower = (text ?? "").toLowerCase();
  return { ids: new Set(lower.match(/\b[a-z]{2,3}-\d+\b/g) ?? []), words: new Set(wordsOf(lower).map((w) => w.replace(/'s$/, ""))) };
}
/** Whether a prepared text names the record: its short id, or two of its distinctive words. */
export function namesRecord(text: NamedText, ref: RecordRef, words: string[] = recordWords(ref.title)): boolean {
  if (ref.short_id && text.ids.has(ref.short_id.toLowerCase())) return true;
  let hits = 0;
  for (const w of words) if (text.words.has(w) && ++hits >= 2) return true;
  return false;
}

// ── Landing: the commits on main that name a record ─────────────────────────
// The analyzer used to search the main branch's log by title words for every
// flagged record, and recall moved with how many rows a run cared to read (9
// to 27 of 41 by sample, 2026-09-22). The join is done here instead, from the
// commits the activity slice already holds: up to LANDING_PER_RECORD landed
// commits per record, newest first, each with its sha, date and first line.
// An empty list is a fact the run can cite: no commit on main in the window
// names the record.
export const LANDING_PER_RECORD = 3;
export const LANDING_LINE_CHARS = 120;
export function landingFor(commits: ActivityCommit[], ref: RecordRef, cap = LANDING_PER_RECORD): LandedCommit[] {
  const words = recordWords(ref.title);
  const hits: LandedCommit[] = [];
  for (const c of commits) {
    if (!c.sha || !isLandedCommit(c)) continue;
    if (!namesRecord(namedTextOf(c.message), ref, words)) continue;
    hits.push({ sha: c.sha.slice(0, 12), at: c.timestamp, line: (c.message ?? "").split("\n")[0].slice(0, LANDING_LINE_CHARS) });
  }
  return hits.sort((a, b) => b.at - a.at).slice(0, cap);
}

/** The open tasks and plans a scanned session is bound to, with their landing:
 *  a record somebody is working is judged from what landed for it, not hunted
 *  for. Capped, newest touch first. */
export const BOUND_RECORDS_CAP = 60;
export function computeBound(input: ActivityInputs): { tasks: BoundRecord[]; plans: BoundRecord[] } {
  const sessionsOn = (key: "active_task_id" | "active_plan_id") => {
    const m = new Map<string, ActivitySession[]>();
    for (const s of input.sessions) if (s[key]) m.set(String(s[key]), [...(m.get(String(s[key])) ?? []), s]);
    return m;
  };
  const shape = (rows: Array<ActivityTask | ActivityPlan>, on: Map<string, ActivitySession[]>, closed: (s: string) => boolean): BoundRecord[] =>
    rows.filter((r) => !closed(r.status) && on.has(String(r.id)))
      .map((r) => {
        const bound = on.get(String(r.id))!;
        return { short_id: r.short_id, title: r.title, status: r.status, sessions: bound.length, sessions_live: bound.filter((s) => s.state !== "done" && s.state !== "idle").length, updated_at: r.updated_at, landing: landingFor(input.commits, r) };
      })
      .sort((a, b) => b.updated_at - a.updated_at).slice(0, BOUND_RECORDS_CAP);
  return { tasks: shape(input.tasks, sessionsOn("active_task_id"), isClosedTask), plans: shape(input.plans, sessionsOn("active_plan_id"), isClosedPlan) };
}

const CLOSED = new Set(["done", "dropped", "abandoned"]);
export const isClosedTask = (s: string) => s === "done" || s === "dropped";
export const isClosedPlan = (s: string) => CLOSED.has(s);
const bump = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const areaKey = (repo: string, prefix: string) => `${repo} ${prefix}`;

// ── Areas: where code lands and who lands it ────────────────────────────────
function computeAreas(input: ActivityInputs) {
  const filesCap = input.filesPerCommit ?? FILES_PER_COMMIT;
  const perArea = new Map<string, { repository: string; path_prefix: string; commits: number; authors: Map<string, number> }>();
  const authorToMember = matchAuthors(input.members);
  const coverage: ActivityCommitCoverage = { total: 0, with_files: 0, without_files: 0, spanning_areas: 0, landed: 0 };

  for (const c of input.commits) {
    const repo = (c.repository ?? "").trim();
    if (!repo) continue;
    coverage.total++;
    if (c.sha && isLandedCommit(c)) coverage.landed++;
    const author = (c.author_name ?? c.author_email ?? "").trim() || "unknown";
    const areas = commitAreaPrefixes(c.files, filesCap);
    if (areas.length === 0) coverage.without_files++; else coverage.with_files++;
    if (areas.length > 1) coverage.spanning_areas++;
    const prefixes = new Set<string>(areas.length ? areas : [""]);
    for (const prefix of prefixes) {
      const key = areaKey(repo, prefix);
      const a = perArea.get(key) ?? { repository: repo, path_prefix: prefix, commits: 0, authors: new Map() };
      a.commits++;
      bump(a.authors, author);
      perArea.set(key, a);
    }
  }

  // Sessions land in at most one area: the area of their repo whose prefix
  // their project_path names, else that repo's busiest area. This never
  // double-counts a session across a repo's areas.
  const areasByRepo = new Map<string, Array<{ key: string; prefix: string; commits: number }>>();
  for (const [key, a] of perArea) {
    const list = areasByRepo.get(a.repository) ?? [];
    list.push({ key, prefix: a.path_prefix, commits: a.commits });
    areasByRepo.set(a.repository, list);
  }
  for (const list of areasByRepo.values()) list.sort((x, y) => y.commits - x.commits);

  const sessionsPerArea = new Map<string, Set<string>>();
  const sessionProjectPaths = new Map<string, Map<string, number>>(); // area key → project_path → count
  const areaOfSession = (s: ActivitySession): string | null => {
    const repo = (s.repo ?? "").trim();
    if (!repo) return null;
    const list = areasByRepo.get(repo);
    if (!list || list.length === 0) return null;
    const prefix = sessionAreaPrefix(s);
    const match = prefix !== null ? list.find((x) => x.prefix === prefix) : undefined;
    return (match ?? list[0]).key;
  };
  for (const s of input.sessions) {
    const key = areaOfSession(s);
    if (!key) continue;
    const set = sessionsPerArea.get(key) ?? new Set<string>();
    set.add(s._id);
    sessionsPerArea.set(key, set);
    if (s.project_path) { const m = sessionProjectPaths.get(key) ?? new Map(); bump(m, s.project_path); sessionProjectPaths.set(key, m); }
  }

  // A project resolves to an area by the project_path the area's sessions most
  // often run in, else by a project whose own path prefix equals the area's.
  // A path several projects file under belongs to none of them alone: the
  // last project to set the map won a whole repository's commits on Codecast
  // (five projects share two paths, and packages/web read as Agents & Clients
  // work, which has no open task; 2026-09-22). Such a path names no project
  // and the area says how many share it, so the analyzer reads that project's
  // load from its tasks and sessions and not from the path.
  // Paths are keyed by their prefix inside the repository, not the absolute
  // string: the same directory on two machines (Ashot's and Samvit's checkouts
  // of union-mobile/outreach) is one path, and eight Union projects file under it.
  const pathKey = (path: string) => projectPathPrefix(path) ?? path;
  const projectsByPath = new Map<string, ActivityProject[]>();
  for (const p of input.projects) if (p.project_path) projectsByPath.set(pathKey(p.project_path), [...(projectsByPath.get(pathKey(p.project_path)) ?? []), p]);
  const projectByPath = new Map<string, ActivityProject>();
  const sharedByPath = new Map<string, number>();
  for (const [path, ps] of projectsByPath) { if (ps.length === 1) projectByPath.set(path, ps[0]); else sharedByPath.set(path, ps.length); }

  let areas: ActivityArea[] = Array.from(perArea.values()).map((a) => {
    const key = areaKey(a.repository, a.path_prefix);
    const paths = sessionProjectPaths.get(key);
    let projectId: string | undefined;
    let sharedBy: number | undefined;
    if (paths) {
      const ranked = Array.from(paths.entries()).sort((x, y) => y[1] - x[1]).map(([path]) => pathKey(path));
      const top = ranked.map((path) => projectByPath.get(path)).find(Boolean);
      if (top) projectId = top.id;
      else sharedBy = ranked.map((path) => sharedByPath.get(path)).find(Boolean);
    }
    if (!projectId && !sharedBy) {
      const byPrefix = input.projects.filter((p) => projectPathPrefix(p.project_path) === a.path_prefix);
      if (byPrefix.length === 1) projectId = byPrefix[0].id;
      else if (byPrefix.length > 1) sharedBy = byPrefix.length;
    }
    return {
      repository: a.repository,
      path_prefix: a.path_prefix,
      commits_30d: a.commits,
      authors: Array.from(a.authors.entries()).sort((x, y) => y[1] - x[1]).map(([name, commits]) => ({ name, commits })),
      sessions_30d: sessionsPerArea.get(key)?.size ?? 0,
      ...(projectId ? { project_id: projectId } : {}),
      ...(sharedBy ? { project_shared_by: sharedBy } : {}),
    };
  });
  areas.sort((x, y) => y.commits_30d - x.commits_30d || y.sessions_30d - x.sessions_30d || (x.path_prefix < y.path_prefix ? -1 : 1));
  if (input.maxAreas && areas.length > input.maxAreas) areas = areas.slice(0, input.maxAreas);
  return { areas, authorToMember, coverage };
}

/** name/email (lowercased) → member user_id, for attributing commits. */
function matchAuthors(members: ActivityMember[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const mem of members) {
    if (mem.name) m.set(mem.name.toLowerCase(), mem.user_id);
    if (mem.email) m.set(mem.email.toLowerCase(), mem.user_id);
  }
  return m;
}

// ── People by area: what each person authors and works ──────────────────────
function computePeople(input: ActivityInputs, authorToMember: Map<string, string>): ActivityPerson[] {
  const byMember = new Map<string, Map<string, { commits: number; sessions: number }>>();
  const ensure = (uid: string, prefix: string) => {
    const areas = byMember.get(uid) ?? new Map();
    const cell = areas.get(prefix) ?? { commits: 0, sessions: 0 };
    areas.set(prefix, cell); byMember.set(uid, areas);
    return cell;
  };
  const filesCap = input.filesPerCommit ?? FILES_PER_COMMIT;
  for (const c of input.commits) {
    const uid = authorToMember.get((c.author_name ?? "").toLowerCase()) ?? authorToMember.get((c.author_email ?? "").toLowerCase());
    if (!uid) continue;
    const areas = commitAreaPrefixes(c.files, filesCap);
    for (const prefix of areas.length ? areas : [""]) ensure(uid, prefix).commits++;
  }
  for (const s of input.sessions) {
    const uid = s.owner_user_id ? String(s.owner_user_id) : null;
    const prefix = sessionAreaPrefix(s);
    if (uid && prefix !== null) ensure(uid, prefix).sessions++;
  }
  const nameOf = new Map(input.members.map((m) => [m.user_id, m.name]));
  const people: ActivityPerson[] = [];
  for (const [uid, areas] of byMember) {
    const rows = Array.from(areas.entries())
      .map(([path_prefix, v]) => ({ path_prefix, commits: v.commits, sessions: v.sessions }))
      .filter((r) => r.commits > 0 || r.sessions > 0)
      .sort((x, y) => (y.commits + y.sessions) - (x.commits + x.sessions));
    if (rows.length) people.push({ user_id: uid, name: nameOf.get(uid) ?? "", areas: rows });
  }
  people.sort((x, y) => y.areas.length - x.areas.length);
  return people;
}

// ── Stale records: the filing the evidence contradicts ──────────────────────
export function computeStale(input: ActivityInputs): StaleWork {
  const { now } = input;
  const tasksByPlan = new Map<string, ActivityTask[]>();
  const tasksByProject = new Map<string, ActivityTask[]>();
  for (const t of input.tasks) {
    if (t.plan_id) tasksByPlan.set(String(t.plan_id), [...(tasksByPlan.get(String(t.plan_id)) ?? []), t]);
    if (t.project_id) tasksByProject.set(String(t.project_id), [...(tasksByProject.get(String(t.project_id)) ?? []), t]);
  }
  // Sessions bound to a task (active_task_id) and to a plan (active_plan_id).
  const sessionsByTask = new Map<string, ActivitySession[]>();
  const sessionsByPlan = new Map<string, ActivitySession[]>();
  for (const s of input.sessions) {
    if (s.active_task_id) sessionsByTask.set(String(s.active_task_id), [...(sessionsByTask.get(String(s.active_task_id)) ?? []), s]);
    if (s.active_plan_id) sessionsByPlan.set(String(s.active_plan_id), [...(sessionsByPlan.get(String(s.active_plan_id)) ?? []), s]);
  }
  // A bound session is live while somebody or something still acts on it:
  // working, waiting on a person, or parked on a wake. Done and idle are not.
  const isLive = (s: ActivitySession) => s.state !== "done" && s.state !== "idle";
  const lastTouch = (rows: ActivitySession[]): number | null => {
    const stamps = rows.map((s) => s.updated_at ?? 0).filter((t) => t > 0);
    return stamps.length ? Math.max(...stamps) : null;
  };
  // A task id carried by a landed commit: one on the default branch. A commit
  // on a feature branch or an open pull request names the task and has not
  // landed, and read as landed it closes work that is one push from main.
  const tasksWithCommit = new Set<string>();
  for (const c of input.commits) if (isLandedCommit(c)) for (const id of c.task_ids ?? []) tasksWithCommit.add(String(id));
  // The newest touch on a project's own path, for the project idle clock.
  const sessionTouchByProjectPath = new Map<string, number>();
  for (const s of input.sessions) if (s.project_path) sessionTouchByProjectPath.set(s.project_path, Math.max(sessionTouchByProjectPath.get(s.project_path) ?? 0, 0));
  const commitTouchByRepo = new Map<string, number>();
  for (const c of input.commits) if (c.repository) commitTouchByRepo.set(c.repository, Math.max(commitTouchByRepo.get(c.repository) ?? 0, c.timestamp));

  // Plans: active or draft whose evidence says finished. Task activity is the
  // primary signal and overrides the session signal: a plan whose tasks moved
  // this week is live whatever its bound sessions say. A plan with open tasks
  // that nothing touched for the stale window and no live session on it is
  // stale whether or not it ever had a session. "Bound sessions all done" is
  // the weaker, confirming reason: every session that worked it settled and
  // its tasks have been quiet for the task window (14 days), not yet 21. A
  // plan with no tasks is an idea, not a load, and is never stale here. The
  // quiet clock reads every word on the plan, not task writes alone: a comment
  // on the plan and a session bound to it are activity, and a plan with either
  // inside the window is being worked whatever its open tasks say. A plan
  // marked done whose open tasks are still written, or that a live session
  // still works, is the opposite fault: closed on paper, alive in fact.
  const plans: StalePlan[] = [];
  for (const pl of input.plans) {
    const mine = tasksByPlan.get(String(pl.id)) ?? [];
    const bound = sessionsByPlan.get(String(pl.id)) ?? [];
    const liveSessions = bound.filter(isLive);
    const open = mine.filter((t) => !CLOSED.has(t.status));
    const lastOpenTaskAt = open.length ? Math.max(...open.map((t) => t.updated_at ?? 0)) : 0;
    if (pl.status === "done") {
      // A leftover open task under a finished plan is a follow up, not the plan still running: only a task in progress counts.
      // One week, not the two of the quiet clock: three Union samples reopened five done plans on a two week reading, and four of them were finished with one forgotten row.
      const workedOpen = open.some((t) => t.status === "in_progress" && now - (t.updated_at ?? 0) < DONE_STILL_WORKED_DAYS * D);
      // A session parked on the plan after it closed (waiting on a person, or on a wake) is not working it; only a session working now is.
      // Five finished Union plans were flagged on parked sessions alone (2026-09-21).
      const workedLive = bound.some((s) => s.state === "working");
      if (workedOpen || workedLive) plans.push({ short_id: pl.short_id, title: pl.title, status: pl.status, last_task_activity_at: lastOpenTaskAt || null, sessions_live: liveSessions.length, reason: "marked done, still worked" });
      continue;
    }
    if (pl.status !== "active" && pl.status !== "draft") continue;
    // The clock reads the OPEN tasks: a closed task touched last week (its
    // close) says nothing about whether the rows still open are being worked.
    const lastTaskAt = open.length ? lastOpenTaskAt : mine.length ? Math.max(...mine.map((t) => t.updated_at ?? 0)) : null;
    const lastWordAt = lastTaskAt === null ? null : Math.max(lastTaskAt, pl.last_entry_at ?? 0, lastTouch(bound) ?? 0);
    let reason: StalePlan["reason"] | null = null;
    if (mine.length > 0 && open.length === 0) reason = "every task closed";
    else if (lastWordAt !== null && now - lastWordAt >= STALE_PLAN_DAYS * D && liveSessions.length === 0) reason = "no activity 21d";
    else if (lastWordAt !== null && now - lastWordAt >= STALE_TASK_DAYS * D && bound.length > 0 && bound.every((s) => s.state === "done")) reason = "bound sessions all done";
    if (reason) plans.push({ short_id: pl.short_id, title: pl.title, status: pl.status, last_task_activity_at: lastTaskAt, sessions_live: liveSessions.length, reason });
  }

  // Tasks: an open task a landed commit already carried; an in-progress task
  // that never had a session and no write for the window (filed in bulk and
  // never picked up: open or backlog is its honest status); an in-progress
  // task whose sessions came and settled (bound ones all done, or unbound
  // since) while it sat untouched for the window (done or dropped, by its
  // evidence). Every reason needs the row itself quiet for the window: a task
  // written this week (a comment, a status move, a bound session's touch) is
  // alive whatever an older commit says, and a landed commit on a row whose
  // newest word says more is coming is not a finished task.
  const tasks: StaleTask[] = [];
  for (const t of input.tasks) {
    if (isClosedTask(t.status)) continue;
    const linked = sessionsByTask.get(String(t.id)) ?? [];
    const everHad = linked.length > 0 || (t.conversation_ids?.length ?? 0) > 0;
    const lastSessionAt = lastTouch(linked);
    const quiet = now - Math.max(t.updated_at ?? 0, lastSessionAt ?? 0) >= STALE_TASK_DAYS * D;
    let reason: StaleTask["reason"] | null = null;
    if (!quiet) reason = null;
    else if (tasksWithCommit.has(String(t.id))) reason = "commits landed, still open";
    else if (t.status === "in_progress" && !everHad) reason = "in progress, no session 14d";
    else if (t.status === "in_progress" && linked.every((s) => s.state === "done")) reason = "in progress, sessions done 14d";
    else if (t.status === "open" && !everHad && now - (t.updated_at ?? 0) >= STALE_OPEN_DAYS * D) reason = "open, untouched 45d";
    if (reason) tasks.push({ short_id: t.short_id, title: t.title, status: t.status, last_session_activity_at: lastSessionAt, reason });
  }

  // Projects: nothing touched them in the window. A task, a plan, a session in
  // the project's path, or a commit to a repo the project owns all count.
  const projects: StaleProject[] = [];
  for (const p of input.projects) {
    if (CLOSED.has(p.status)) continue;
    let last = p.updated_at ?? 0;
    for (const t of tasksByProject.get(String(p.id)) ?? []) last = Math.max(last, t.updated_at ?? 0);
    for (const pl of input.plans) if (String(pl.project_id ?? "") === String(p.id)) last = Math.max(last, pl.updated_at ?? 0);
    if (p.project_path && sessionTouchByProjectPath.has(p.project_path)) {
      for (const s of input.sessions) if (s.project_path === p.project_path) last = now; // a live scan row is a touch now
    }
    if (now - last >= STALE_PROJECT_DAYS * D) projects.push({ id: p.id, title: p.title, reason: "no activity 30d" });
  }

  return { plans, tasks, projects };
}

/** The activity block (org-staffing.md S9): where work is, who is in it, and
 *  which records the evidence says are finished. Pure over the rows. */
export function computeOrgActivity(input: ActivityInputs): OrgActivity {
  const { areas, authorToMember, coverage } = computeAreas(input);
  const people = computePeople(input, authorToMember);
  const stale = computeStale(input);
  // Every flagged record carries what landed for it on main (landingFor).
  for (const r of [...stale.plans, ...stale.tasks]) r.landing = landingFor(input.commits, r);
  return { areas, people, stale, bound: computeBound(input), commits: coverage };
}
