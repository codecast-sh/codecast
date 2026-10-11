// The line app's selection lives in its URL (line-workspace.md LW1), so any
// state is a link and every view reads the same one. The line is one app over
// the process; a project is a filter on it, never a line of its own:
//   project  the filter (a project's short id or row id); absent is every project
//   view     inbox, sources, problems, runs, process, chat (the left nav, keys 1 to 6)
//   mode     the Process view's mode: graph (default) or notebook
//   graph    which process (codecast's line, AgentWatch, ...)
//   step     a station id; tab, the step drawer's open tab
//   run      a run id: Runs opens it as the run detail (Replay)
//   case     a problem's task id: Problems opens its timeline
//   source   a source's name: Sources opens its findings
//   finding  a finding's (signal's) id: Sources opens it
// Selecting a run keeps its case; selecting a case drops a run of another
// case; moving to another step drops the tab; another view keeps only what it
// reads (Process: the step); another graph or project drops what named the
// old one. The views'
// earlier names (graph, notebook, replay, timeline) still read and write, as
// the view that now holds them. Pure, so a test reads and writes addresses.

export const LINE_VIEWS = ["inbox", "sources", "problems", "runs", "process", "chat"] as const;
export type LineView = (typeof LINE_VIEWS)[number];
export const DEFAULT_LINE_VIEW: LineView = "inbox";

export const LINE_MODES = ["graph", "notebook"] as const;
export type LineMode = (typeof LINE_MODES)[number];
export const DEFAULT_LINE_MODE: LineMode = "graph";

/** The views' earlier names, each the view and mode that hold it now. */
const LEGACY_VIEWS = { graph: ["process", "graph"], notebook: ["process", "notebook"], replay: ["runs", null], timeline: ["problems", null] } as const;
type LegacyView = keyof typeof LEGACY_VIEWS;
/** A view as a link may name it: its own name, or an earlier one. */
export type LineViewName = LineView | LegacyView;

export type LineSelection = { view: LineView; mode: LineMode; project: string | null; graph: string | null; step: string | null; tab: string | null; run: string | null; case: string | null; source: string | null; finding: string | null };
export type LineSelectionPatch = Partial<{ view: LineViewName | null; mode: LineMode | null; project: string | null; graph: string | null; step: string | null; tab: string | null; run: string | null; case: string | null; source: string | null; finding: string | null }>;

type Search = { get(key: string): string | null } | null | undefined;

const KEYS = ["project", "view", "mode", "graph", "step", "tab", "run", "case", "source", "finding"] as const;
const isView = (v: string | null | undefined): v is LineView => !!v && (LINE_VIEWS as readonly string[]).includes(v);
const isLegacy = (v: string | null | undefined): v is LegacyView => !!v && v in LEGACY_VIEWS;
const isMode = (v: string | null | undefined): v is LineMode => !!v && (LINE_MODES as readonly string[]).includes(v);
/** The selection each view reads; moving to a view drops the rest, unless the move names it. */
const SELECTION_KEYS = ["step", "tab", "run", "case", "source", "finding"] as const;
const VIEW_KEEPS: Record<LineView, ReadonlyArray<(typeof SELECTION_KEYS)[number]>> = {
  inbox: [], sources: ["source", "finding"], problems: ["case"], runs: ["run", "case", "step", "tab"], process: ["step", "tab"], chat: [],
};
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
    mode: asked?.[1] ?? (isMode(mode) ? mode : DEFAULT_LINE_MODE),
    project: ALL.has(project) ? null : project,
    graph: search?.get("graph") || null,
    step: search?.get("step") || null,
    tab: search?.get("tab") || null,
    run: search?.get("run") || null,
    case: search?.get("case") || null,
    source: search?.get("source") || null,
    finding: search?.get("finding") || null,
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
    q.set("view", legacy[0]);
    if (legacy[1]) q.set("mode", legacy[1]);
  }
  const p: LineSelectionPatch = { ...patch };
  if (p.view) {
    const [view, mode] = resolveView(p.view) ?? [DEFAULT_LINE_VIEW, null];
    p.view = view;
    if (mode && p.mode === undefined) p.mode = mode;
  }
  const set = (k: (typeof KEYS)[number], v: string | null | undefined) => {
    if (v == null || v === "" || (k === "view" && v === DEFAULT_LINE_VIEW) || (k === "mode" && v === DEFAULT_LINE_MODE) || (k === "project" && ALL.has(v))) q.delete(k);
    else q.set(k, v);
  };
  for (const k of KEYS) if (p[k] !== undefined) set(k, p[k]);
  if (q.get("view") !== "process") q.delete("mode");
  if (p.project !== undefined && (p.project || null) !== before.project) {
    for (const k of ["graph", "step", "tab", "run", "case", "finding"] as const) if (p[k] === undefined) q.delete(k);
  }
  if (p.graph !== undefined && p.graph !== before.graph) {
    for (const k of ["step", "tab", "run", "case"] as const) if (p[k] === undefined) q.delete(k);
  }
  // Another view keeps only the selection that belongs to it.
  const view = resolveView(q.get("view"))?.[0] ?? DEFAULT_LINE_VIEW;
  if (p.view !== undefined && view !== before.view) {
    for (const k of SELECTION_KEYS) if (p[k] === undefined && !VIEW_KEEPS[view].includes(k)) q.delete(k);
  }
  if (p.step !== undefined && p.step !== before.step && p.tab === undefined) q.delete("tab");
  if (p.run && runCase !== undefined && p.case === undefined) set("case", runCase);
  if (p.case !== undefined && p.case !== before.case && p.run === undefined) q.delete("run");
  if (p.source !== undefined && p.source !== before.source && p.finding === undefined) q.delete("finding");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** A view's name in the nav, in nav order (keys 1 to 6). */
export const LINE_VIEW_LABELS: Record<LineView, string> = { inbox: "Inbox", sources: "Sources", problems: "Problems", runs: "Runs", process: "Process", chat: "Chat" };
export const LINE_MODE_LABELS: Record<LineMode, string> = { graph: "Graph", notebook: "Notebook" };

/** The view a digit key opens: "1" is the first view, "6" the last; null for any other key. */
export const lineViewForKey = (key: string): LineView | null => {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= LINE_VIEWS.length ? LINE_VIEWS[n - 1] : null;
};

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
  const step = node && node !== QUEUE_NODE ? node : edge ? edge.split("->")[0] || null : null;
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
