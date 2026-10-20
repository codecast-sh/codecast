// The line app's selection lives in its URL (line-journeys.md LJ5), so any
// state is a link and every view reads the same one. The line is one app over
// the process; a project is a filter on it, never a line of its own:
//   project  the filter (a project's short id or row id); absent is every project
//   view     foryou (the landing page), problems, line, deploys: the nav entries
//   mode     the Line page's mode: table (default) or map
//   graph    which process (codecast's line, AgentWatch, ...) Line draws, and an open problem or run is read in
//   process  Problems' narrowing to one process; absent, Problems lists every process, as For you does
//   need     what waits on the viewer, open in For you's reader: a problem's
//            ref (ct-N), a decision's (sd-N) or a trial card's (tc-N)
//   step     a station id; steptab, the step's open tab (its own key, so
//            a host page's `tab`, the project page's, is never touched)
//   show     a step page's one filter: waiting, failed or passed (LJ8.6)
//   run      a run id: Problems opens it under its problem, as the run page
//   case     a problem's ref (ct-N), else its task id: Problems opens its page.
//            The address carries the ref, so a copied link reads; the views
//            read the row id (caseRefs)
//   source   a finder's name: Line opens it
//   stage    a leading stage of the line open as a drawer over the Map:
//            moments, expectations, judges, grouping or dispatch
//   item     the object open inside that stage's drawer (a moment kind or
//            mo-N, a judge's name, a problem's ref)
//   finding  a finding's (signal's) id, open in place
//   row      a problem page's expanded run row (its run id), open in place
//   ask      1: the open problem's question, its answer box focused
//   deploy   a deploy's ref (dp-N), open on the Deploys view (deploys.md DP7)
//   card     a trial card's ref, decision a fix decision's (sd-N): kept for
//            links already sent. For you settles either on its `need`.
// Selecting a run keeps its case; selecting a case drops a run of another
// case; moving to another step drops the tab; another view keeps only what it
// reads; another graph or project drops what named the old one. Keys the line
// does not own stay as they are. The views' earlier names (inbox, runs,
// sources, process, chat, graph, notebook, replay, timeline) still read and
// write, as the view that holds their job now. Pure, so a test reads and
// writes addresses.

export const LINE_VIEWS = ["foryou", "problems", "line", "deploys"] as const;
export type LineView = (typeof LINE_VIEWS)[number];
export const DEFAULT_LINE_VIEW: LineView = "foryou";

export const LINE_MODES = ["table", "map"] as const;
export type LineMode = (typeof LINE_MODES)[number];
export const DEFAULT_LINE_MODE: LineMode = "table";

/** The stages before the line's own stations, in the order work flows through them (learning-loop.md LL1): what the
 *  product sends, what it should do, who grades it, how findings become problems, and what starts a run. Each opens
 *  as a drawer over the Map. */
export const LINE_STAGES = ["moments", "expectations", "judges", "grouping", "dispatch"] as const;
export type LineStage = (typeof LINE_STAGES)[number];
const stageOf = (v: string | null | undefined): LineStage | null => ((LINE_STAGES as readonly string[]).includes(v ?? "") ? (v as LineStage) : null);

/** The views' earlier names, each the view and mode that hold its job now (LJ4): the Inbox is For you; a run is read
 *  under its problem; a source is a finder on Line; the graph is Line's map, the notebook its table; Chat is a step's
 *  instructions. */
const LEGACY_VIEWS = {
  inbox: ["foryou", null], runs: ["problems", null], replay: ["problems", null], timeline: ["problems", null],
  sources: ["line", null], process: ["line", "map"], graph: ["line", "map"], notebook: ["line", "table"], chat: ["line", null],
} as const;
/** The modes' earlier names. */
const LEGACY_MODES: Record<string, LineMode> = { graph: "map", notebook: "table" };
type LegacyView = keyof typeof LEGACY_VIEWS;
/** A view as a link may name it: its own name, or an earlier one. */
export type LineViewName = LineView | LegacyView;

export type LineSelection = { view: LineView; mode: LineMode; project: string | null; graph: string | null; step: string | null; tab: string | null; run: string | null; case: string | null; source: string | null; finding: string | null; row: string | null; ask: boolean; card: string | null; decision: string | null; need: string | null; status: string | null; process: string | null; quiet: boolean; found: string | null; q: string | null; sort: string | null; win: string | null; show: string | null; stage: LineStage | null; item: string | null; who: string | null; kind: string | null; area: string | null; order: string | null; group: string | null; deploy: string | null };
export type LineSelectionPatch = Partial<{ view: LineViewName | null; mode: LineMode | "graph" | "notebook" | null; project: string | null; graph: string | null; step: string | null; tab: string | null; run: string | null; case: string | null; source: string | null; finding: string | null; row: string | null; ask: string | null; card: string | null; decision: string | null; need: string | null; status: string | null; process: string | null; quiet: string | null; found: string | null; q: string | null; sort: string | null; win: string | null; show: string | null; stage: LineStage | null; item: string | null; who: string | null; kind: string | null; area: string | null; order: string | null; group: string | null; deploy: string | null }>;

type Search = { get(key: string): string | null } | null | undefined;

const KEYS = ["project", "view", "mode", "graph", "step", "tab", "run", "case", "source", "finding", "row", "ask", "card", "decision", "need", "status", "process", "quiet", "found", "q", "sort", "win", "show", "stage", "item", "who", "kind", "area", "order", "group", "deploy"] as const;
type Key = (typeof KEYS)[number];
/** Where a key lives in the address: the drawer's tab has its own name, `tab` belongs to the page hosting the app. */
const PARAM: Record<Key, string> = { project: "project", view: "view", mode: "mode", graph: "graph", step: "step", tab: "steptab", run: "run", case: "case", source: "source", finding: "finding", row: "row", ask: "ask", card: "card", decision: "decision", need: "need", status: "status", process: "process", quiet: "quiet", found: "found", q: "q", sort: "sort", win: "win", show: "show", stage: "stage", item: "item", who: "who", kind: "kind", area: "area", order: "order", group: "group", deploy: "deploy" };
/** The drawer's tabs, which an older link named as `tab`. */
const DRAWER_TABS = new Set(["prompt", "decisions", "try", "ask"]);
const legacyTab = (search: Search) => { const t = search?.get("tab"); return t && DRAWER_TABS.has(t) ? t : null; };
const isView = (v: string | null | undefined): v is LineView => !!v && (LINE_VIEWS as readonly string[]).includes(v);
const isLegacy = (v: string | null | undefined): v is LegacyView => !!v && v in LEGACY_VIEWS;
const modeOf = (v: string | null | undefined): LineMode | null => (!v ? null : (LINE_MODES as readonly string[]).includes(v) ? (v as LineMode) : LEGACY_MODES[v] ?? null);
/** The selection each view reads; moving to a view drops the rest, unless the move names it. */
// The Problems list's own keys (LJ5): its status chip, its process, the quiet narrowing and a figure's or bar's narrowing
// (`found`: "more", or a picked bar's start) are places; search, sort and window are not.
const SELECTION_KEYS = ["step", "tab", "run", "case", "source", "finding", "row", "ask", "card", "decision", "need", "status", "process", "quiet", "found", "q", "sort", "win", "show", "stage", "item", "who", "kind", "area", "order", "group", "deploy"] as const;
const VIEW_KEEPS: Record<LineView, ReadonlyArray<(typeof SELECTION_KEYS)[number]>> = {
  // A decision rides into Problems only when the move names it: For you's reader settles one on its need, and a
  // problem's band shows its own without it, so a decision kept from another view would follow every later link.
  // For you's list keeps how it is filtered, ordered and grouped.
  foryou: ["need", "card", "decision", "who", "kind", "area", "order", "group"], problems: ["case", "ask", "run", "step", "source", "finding", "row", "status", "process", "quiet", "found", "q", "sort", "win"], line: ["source", "finding", "stage", "item"], deploys: ["deploy"],
};
/** The view that reads a step of its own (Problems reads one too, as an open run's playhead). */
const STEP_VIEWS = new Set<LineView>(["line"]);
/** The view that opens a run's page, where a step is that run's playhead. */
const RUN_VIEWS = new Set<LineView>(["problems"]);
/** What /line names when it names every project. */
const ALL = new Set(["all", ""]);

/** A view name, its own or an earlier one, as the view and the mode it opens (null: the mode stays). */
function resolveView(v: string | null | undefined): [LineView, LineMode | null] | null {
  if (isView(v)) return [v, null];
  if (isLegacy(v)) return [LEGACY_VIEWS[v][0], LEGACY_VIEWS[v][1]];
  return null;
}

export function readLineSelection(search: Search): LineSelection {
  const asked = resolveView(search?.get("view"));
  const mode = search?.get("mode");
  const project = search?.get("project")?.trim() ?? "";
  return {
    view: asked?.[0] ?? DEFAULT_LINE_VIEW,
    // A mode the address names wins over the one an earlier view name implies (view=process&mode=notebook is the table).
    mode: modeOf(mode) ?? asked?.[1] ?? DEFAULT_LINE_MODE,
    project: ALL.has(project) ? null : project,
    graph: search?.get("graph") || null,
    step: search?.get("step") || null,
    tab: search?.get(PARAM.tab) || legacyTab(search) || (search?.get("view") === "chat" && search.get("step") ? "instructions" : null),
    run: search?.get("run") || null,
    case: search?.get("case") || null,
    source: search?.get("source") || null,
    finding: search?.get("finding") || null,
    row: search?.get("row") || null,
    ask: search?.get("ask") === "1",
    card: search?.get("card") || null,
    decision: search?.get("decision") || null,
    need: search?.get("need") || null,
    status: search?.get("status") || null,
    process: search?.get("process") || null,
    quiet: search?.get("quiet") === "1",
    found: search?.get("found") || null,
    q: search?.get("q") || null,
    sort: search?.get("sort") || null,
    win: search?.get("win") || null,
    show: search?.get("show") || null,
    stage: stageOf(search?.get("stage")),
    item: search?.get("item") || null,
    who: search?.get("who") || null,
    kind: search?.get("kind") || null,
    area: search?.get("area") || null,
    order: search?.get("order") || null,
    group: search?.get("group") || null,
    deploy: search?.get("deploy") || null,
  };
}

/**
 * The same address with the selection changed; null removes a key, and the
 * default view and mode are left out. `runCase` names the case of the run
 * being selected, so selecting a run moves the case with it.
 */
export function lineSelectionSearch(current: (Search & { toString(): string }) | null | undefined, patch: LineSelectionPatch, runCase?: string | null): string {
  const q = new URLSearchParams(current?.toString() ?? "");
  const before = readLineSelection(q);
  // An earlier view name in the address settles on the view that holds it now.
  const legacy = resolveView(q.get("view"));
  if (legacy && isLegacy(q.get("view"))) {
    // Chat's job is a step's instructions now: a link that opened Chat on a step opens that tab.
    if (q.get("view") === "chat" && q.get("step") && !q.get(PARAM.tab)) q.set(PARAM.tab, "instructions");
    if (legacy[0] === DEFAULT_LINE_VIEW) q.delete("view"); else q.set("view", legacy[0]);
    if (legacy[1] && !q.get("mode")) q.set("mode", legacy[1]);
  }
  const oldMode = q.get("mode");
  if (oldMode && LEGACY_MODES[oldMode]) q.set("mode", LEGACY_MODES[oldMode]);
  if (q.get("mode") === DEFAULT_LINE_MODE) q.delete("mode");
  const p: LineSelectionPatch = { ...patch };
  // A step names a place on the Line page: picked from a view that has no step of its own, it opens there.
  if (p.step && p.view === undefined && !STEP_VIEWS.has(before.view) && !(RUN_VIEWS.has(before.view) && (p.run ?? before.run))) p.view = "line";
  if (p.view) {
    const named = p.view;
    const [view, mode] = resolveView(named) ?? [DEFAULT_LINE_VIEW, null];
    p.view = view;
    if (mode && p.mode === undefined) p.mode = mode;
    if (named === "chat" && (p.step ?? before.step) && p.tab === undefined) p.tab = "instructions";
  }
  if (p.mode) p.mode = modeOf(p.mode);
  // An older link's drawer tab settles on the drawer's own key.
  const old = legacyTab(q);
  if (old) { q.delete("tab"); if (!q.get(PARAM.tab)) q.set(PARAM.tab, old); }
  const del = (k: Key) => q.delete(PARAM[k]);
  const set = (k: Key, v: string | null | undefined) => {
    if (v == null || v === "" || (k === "view" && v === DEFAULT_LINE_VIEW) || (k === "mode" && v === DEFAULT_LINE_MODE) || (k === "project" && ALL.has(v))) del(k);
    else q.set(PARAM[k], v);
  };
  for (const k of KEYS) if (p[k] !== undefined) set(k, p[k]);
  if (q.get("view") !== "line") q.delete("mode");
  if (p.project !== undefined && (p.project || null) !== before.project) {
    for (const k of ["graph", "step", "tab", "run", "case", "finding", "row", "ask"] as const) if (p[k] === undefined) del(k);
  }
  if (p.graph !== undefined && p.graph !== before.graph) {
    for (const k of ["step", "tab", "run", "case", "ask"] as const) if (p[k] === undefined) del(k);
  }
  // Another view keeps only the selection that belongs to it.
  const view = resolveView(q.get("view"))?.[0] ?? DEFAULT_LINE_VIEW;
  if (p.view !== undefined && view !== before.view) {
    for (const k of SELECTION_KEYS) if (p[k] === undefined && !VIEW_KEEPS[view].includes(k)) del(k);
    // Problems reads a step only as an open run's playhead: its list and a problem's page have no step of their own.
    if (RUN_VIEWS.has(view) && p.step === undefined && !q.get(PARAM.run)) del("step");
  }
  if (p.step !== undefined && p.step !== before.step && p.tab === undefined) del("tab");
  // A step page's filter (LJ8.6 `show`) belongs to that step.
  if (p.step !== undefined && p.step !== before.step && p.show === undefined) del("show");
  if (p.run && runCase !== undefined && p.case === undefined) set("case", runCase);
  if (p.case !== undefined && p.case !== before.case) {
    if (p.run === undefined) del("run");
    if (p.ask === undefined) del("ask");
    // What was open on one problem's page is not open on another's.
    if (p.finding === undefined) del("finding");
    if (p.row === undefined) del("row");
    // A decision belongs to its problem: another problem never inherits it.
    if (p.decision === undefined) del("decision");
  }
  if (p.source !== undefined && p.source !== before.source && p.finding === undefined) del("finding");
  // What was open inside one stage's drawer is not open in another's.
  if (p.stage !== undefined && p.stage !== before.stage && p.item === undefined) del("item");
  // One drawer at a time: a stage opened closes the step, a step opened closes the stage.
  if (p.stage && p.step === undefined) { del("step"); del("tab"); del("show"); }
  if (p.step && p.stage === undefined) { del("stage"); del("item"); }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The keys that name a place: a change to any of them is a move Back and Forward walk. The drawer's tab, a finding
 *  opened in a list, a problem page's expanded run row and the answer box's focus change what a place shows, not the
 *  place: they replace, so reload and Back return to the place as it was left. */
const PLACE_KEYS = ["project", "view", "graph", "step", "run", "case", "source", "card", "decision", "need", "status", "process", "quiet", "found", "stage", "item", "deploy"] as const;

/** Whether moving from one address to the next is a new history entry (push) rather than a correction of the
 *  current one (replace): true when any place key differs, the default view and mode read as named. */
export function lineSelectionPushes(from: Search, to: Search): boolean {
  const a = readLineSelection(from);
  const b = readLineSelection(to);
  return PLACE_KEYS.some((k) => a[k] !== b[k]);
}

/** A project's name as a URL slug: lowercase words joined by dashes. */
export const projectSlug = (name: string): string => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Slugs the line's own paths hold (/line/all, /line/settings, /line/trace): a project so named goes by its short id. */
const RESERVED_SLUG = /^(all|settings|trace)$/;

type ProjectRef = { _id: string; short_id?: string | null; title?: string | null };

/** How the line's filter names a project in its address: by its name's slug, the form /line/<slug> redirects to,
 *  when no other project in `all` (the workspace the line reads) shares it; else by its short id. resolveLineProject reads either back. */
export function lineFilterParam(project: ProjectRef, all: Iterable<ProjectRef>): string {
  const slug = projectSlug(project.title ?? "");
  if (!slug || RESERVED_SLUG.test(slug)) return project.short_id || project._id;
  for (const p of all) if (p._id !== project._id && projectSlug(p.title ?? "") === slug) return project.short_id || project._id;
  return slug;
}

/**
 * The project a `?project=` (or `/line/<project>`) names: a row id, a short id, else a name's slug. A slug resolves
 * among `projects` (every project the store holds); when several share it, the one `inWorkspace` holds wins, so a
 * personal and a team project of the same name never cancel each other out. Undefined when nothing, or more than
 * one in the workspace, matches.
 */
export function resolveLineProject(param: string | null | undefined, projects: Iterable<ProjectRef & { workspace?: string | null }>, inWorkspace?: (p: ProjectRef & { workspace?: string | null }) => boolean): string | undefined {
  if (!param) return undefined;
  const list = [...projects];
  const byId = list.find((p) => p._id === param) ?? list.find((p) => p.short_id === param);
  if (byId) return byId._id;
  const slug = projectSlug(param);
  if (!slug || RESERVED_SLUG.test(slug)) return undefined;
  const named = list.filter((p) => projectSlug(p.title ?? "") === slug);
  if (named.length === 1) return named[0]._id;
  const here = inWorkspace ? named.filter(inWorkspace) : [];
  return here.length === 1 ? here[0]._id : undefined;
}

/**
 * A view's home, as the left nav and the go keys open it: the view with nothing open in it. A nav click never
 * carries an open problem, run, source or need along, and clicking the view already in front closes its detail;
 * only a link that names a thing (a row, a count, "the run") opens it.
 */
export function lineViewHome(view: LineView): LineSelectionPatch {
  return { view, step: null, tab: null, run: null, case: null, source: null, finding: null, row: null, ask: null, card: null, decision: null, need: null, stage: null, item: null, deploy: null };
}

/** A view's name in the nav, in nav order. */
export const LINE_VIEW_LABELS: Record<LineView, string> = { foryou: "Decisions", problems: "Problems", line: "Steps", deploys: "Deploys" };
export const LINE_MODE_LABELS: Record<LineMode, string> = { table: "Table", map: "Map" };

/** The second key of the go chord (G, then this) for each view. The shell binds no digit: an open decision answers
 *  on bare 1 to 9 (LJ5). */
export const LINE_VIEW_KEYS: Record<LineView, string> = { foryou: "f", problems: "p", line: "s", deploys: "d" };

/** The view the second key of the go chord opens; null for any other key. */
export const lineViewForGoKey = (key: string): LineView | null => LINE_VIEWS.find((v) => LINE_VIEW_KEYS[v] === key.toLowerCase()) ?? null;

/** The line app, `/line`, filtered to `project` (null: every project) with the selection `patch` names.
 *  `project` is how the line pages name a project (lineStations lineProjectParam). */
export function lineWorkspaceHref(project: string | null, patch: LineSelectionPatch = {}): string {
  return `/line${lineSelectionSearch(null, { ...patch, project })}`;
}

/** The node the old map opened for the line's settings, and for the queue of problems. */
const SETTINGS_NODE = "line";
const QUEUE_NODE = "causes";

/**
 * Where an old address goes now, or null when it stays. `/line/<project>`
 * (`path`, the segment) is the app filtered to that project, its query kept.
 * An old map address on /line (`?project=&node=`, `edge`, `trace`) keeps its
 * meaning: a node opens that step, an edge the step it leaves, the problems'
 * queue the Problems view, the line's settings panel the settings page, a
 * trace the ref's own place.
 */
export function lineWorkspaceRedirect(search: Search & { toString(): string } | null | undefined, path?: string | null): string | null {
  const project = (path ?? search?.get("project") ?? "").trim();
  const node = search?.get("node") || null;
  const section = search?.get("section") || null;
  const trace = search?.get("trace");
  const edge = search?.get("edge");
  if (!path && !node && !trace && !edge) return null;
  if (node === SETTINGS_NODE) return `/line/settings?${new URLSearchParams({ ...(project && !ALL.has(project) ? { project } : {}), ...(section ? { section } : {}) }).toString()}`;
  if (trace) return `/line/trace/${encodeURIComponent(trace)}`;
  const step = node && node !== QUEUE_NODE ? node : edge ? edge.split("->")[0] || null : search?.get("step") || null;
  // The project leads the address, and what the old one named stays named.
  const kept = new URLSearchParams(project && !ALL.has(project) ? { project } : {});
  for (const [k, v] of new URLSearchParams(search?.toString() ?? "")) if (!["project", "node", "edge", "section", "window", "trace"].includes(k)) kept.append(k, v);
  return `/line${lineSelectionSearch(kept, { ...(step ? { step } : {}), ...(node === QUEUE_NODE ? { view: "problems" as const } : {}) })}`;
}

/** Any ref the line knows (a problem, a finding, a fingerprint, a run, a card)
 *  at its place in the line app: `/line/trace/<ref>` resolves it
 *  (LineRefRedirect). The path keeps its old name so links already sent still open. */
export const lineRefHref = (ref: string) => `/line/trace/${encodeURIComponent(ref)}`;

/** The ref a /line/trace/<ref> segment names. The router may have decoded it
 *  already, so a ref holding a bare "%" stays as it is rather than throwing. */
export function lineRefOf(segment: string): string {
  try { return decodeURIComponent(segment).trim(); } catch { return segment.trim(); }
}

/** A problem named both ways: the address carries its ref (ct-N) so a link someone copies reads, and every view
 *  reads its row id. `id` turns either into the row id, `ref` either into the ref; a value no problem in view
 *  holds stays as it is. */
export type CaseRefs = { id: (v: string) => string; ref: (v: string) => string };

export function caseRefs(tasks: ReadonlyArray<{ _id: string; short_id?: string | null }>): CaseRefs {
  const toId = new Map<string, string>();
  const toRef = new Map<string, string>();
  for (const t of tasks) {
    if (!t.short_id) continue;
    toId.set(t.short_id, t._id);
    toRef.set(t._id, t.short_id);
  }
  return { id: (v) => toId.get(v) ?? v, ref: (v) => toRef.get(v) ?? v };
}
