// The line workspace's shared selection lives in its URL (line-workspace.md
// LW1), so any state is a link and every view reads the same one: `view`
// (graph, notebook, replay, chat, timeline), `graph` (which of the project's
// graphs), `step` (a station id), `tab` (the step's open tab: prompt,
// decisions, try, ask), `run` (a run id) and `case` (a cause's task id).
// Selecting a run keeps its case; selecting a case drops a run of another
// case; moving to another step drops the tab. Pure, so a test reads and
// writes addresses.

export const LINE_VIEWS = ["graph", "notebook", "replay", "chat", "timeline"] as const;
export type LineView = (typeof LINE_VIEWS)[number];
export const DEFAULT_LINE_VIEW: LineView = "graph";

export type LineSelection = { view: LineView; graph: string | null; step: string | null; tab: string | null; run: string | null; case: string | null };
export type LineSelectionPatch = Partial<{ view: LineView | null; graph: string | null; step: string | null; tab: string | null; run: string | null; case: string | null }>;

type Search = { get(key: string): string | null } | null | undefined;

const KEYS = ["view", "graph", "step", "tab", "run", "case"] as const;
const isView = (v: string | null | undefined): v is LineView => !!v && (LINE_VIEWS as readonly string[]).includes(v);

export function readLineSelection(search: Search): LineSelection {
  const view = search?.get("view");
  return {
    view: isView(view) ? view : DEFAULT_LINE_VIEW,
    graph: search?.get("graph") || null,
    step: search?.get("step") || null,
    tab: search?.get("tab") || null,
    run: search?.get("run") || null,
    case: search?.get("case") || null,
  };
}

/**
 * The same address with the selection changed; null removes a key and the
 * default view is left out. `runCase` names the case of the run being
 * selected, so selecting a run moves the case with it; changing the case
 * alone drops a run that belonged to the old one, and changing the graph
 * drops the step and run, which name things in the old graph.
 */
export function lineSelectionSearch(current: (Search & { toString(): string }) | null | undefined, patch: LineSelectionPatch, runCase?: string | null): string {
  const q = new URLSearchParams(current?.toString() ?? "");
  const before = readLineSelection(q);
  const set = (k: (typeof KEYS)[number], v: string | null | undefined) => {
    if (v == null || v === "" || (k === "view" && v === DEFAULT_LINE_VIEW)) q.delete(k);
    else q.set(k, v);
  };
  for (const k of KEYS) if (patch[k] !== undefined) set(k, patch[k]);
  if (patch.graph !== undefined && patch.graph !== before.graph) {
    if (patch.step === undefined) q.delete("step");
    if (patch.tab === undefined) q.delete("tab");
    if (patch.run === undefined) q.delete("run");
  }
  if (patch.step !== undefined && patch.step !== before.step && patch.tab === undefined) q.delete("tab");
  if (patch.run && runCase !== undefined && patch.case === undefined) set("case", runCase);
  if (patch.case !== undefined && patch.case !== before.case && patch.run === undefined) q.delete("run");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** A view's name as its switch says it, in switch order (keys 1 to 5). */
export const LINE_VIEW_LABELS: Record<LineView, string> = { graph: "Graph", notebook: "Notebook", replay: "Replay", chat: "Chat", timeline: "Timeline" };

/** The view a digit key opens: "1" is the first view, "5" the last; null for any other key. */
export const lineViewForKey = (key: string): LineView | null => {
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 && n <= LINE_VIEWS.length ? LINE_VIEWS[n - 1] : null;
};

/** A project's workspace, `/line/<project>`, with the selection `patch` names.
 *  `project` is how the line pages name a project (lineStations lineProjectParam). */
export function lineWorkspaceHref(project: string, patch: LineSelectionPatch = {}): string {
  return `/line/${encodeURIComponent(project)}${lineSelectionSearch(null, patch)}`;
}

/** What /line lists rather than one project's line. */
const NOT_ONE_LINE = new Set(["all", "none"]);
/** The node the old map opened for the line's settings, and for the queue of problems. */
const SETTINGS_NODE = "line";
const QUEUE_NODE = "causes";

/**
 * Where an old `/line?project=<p>` address goes now: one project's line is its
 * workspace, `/line/<p>`, keeping the graph it named. What the old map's
 * address opened keeps its meaning: a node opens that step, an edge the step
 * it leaves, the problems' queue the Timeline, the line's settings panel
 * the settings page, a trace the ref's own place. The overview (no project,
 * all of them, or the causes under none) stays where it is. Null when the
 * address stays.
 */
export function lineWorkspaceRedirect(search: Search): string | null {
  const project = search?.get("project")?.trim();
  if (!project || NOT_ONE_LINE.has(project)) return null;
  const node = search?.get("node") || null;
  const section = search?.get("section") || null;
  if (node === SETTINGS_NODE) return `/line/settings?${new URLSearchParams({ project, ...(section ? { section } : {}) }).toString()}`;
  const trace = search?.get("trace");
  if (trace) return `/line/trace/${encodeURIComponent(trace)}`;
  const edge = search?.get("edge");
  const step = node && node !== QUEUE_NODE ? node : edge ? edge.split("->")[0] || null : null;
  return lineWorkspaceHref(project, { graph: search?.get("graph") || null, step, ...(node === QUEUE_NODE ? { view: "timeline" as const } : {}) });
}

/** Any ref the line knows (a problem, a finding, a fingerprint, a run, a card)
 *  at its place in its project's workspace: `/line/trace/<ref>` resolves it
 *  (LineRefRedirect). The path keeps its old name so links already sent still open. */
export const lineRefHref = (ref: string) => `/line/trace/${encodeURIComponent(ref)}`;

/** The ref a /line/trace/<ref> segment names. The router may have decoded it
 *  already, so a ref holding a bare "%" stays as it is rather than throwing. */
export function lineRefOf(segment: string): string {
  try { return decodeURIComponent(segment).trim(); } catch { return segment.trim(); }
}
