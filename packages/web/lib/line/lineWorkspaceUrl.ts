// The line workspace's shared selection lives in its URL (line-workspace.md
// LW1), so any state is a link and every view reads the same one: `view`
// (graph, notebook, replay, chat, timeline), `graph` (which of the project's
// graphs), `step` (a station id), `run` (a run id) and `case` (a cause's task
// id). Selecting a run keeps its case; selecting a case drops a run of
// another case. Pure, so a test reads and writes addresses.

export const LINE_VIEWS = ["graph", "notebook", "replay", "chat", "timeline"] as const;
export type LineView = (typeof LINE_VIEWS)[number];
export const DEFAULT_LINE_VIEW: LineView = "graph";

export type LineSelection = { view: LineView; graph: string | null; step: string | null; run: string | null; case: string | null };
export type LineSelectionPatch = Partial<{ view: LineView | null; graph: string | null; step: string | null; run: string | null; case: string | null }>;

type Search = { get(key: string): string | null } | null | undefined;

const KEYS = ["view", "graph", "step", "run", "case"] as const;
const isView = (v: string | null | undefined): v is LineView => !!v && (LINE_VIEWS as readonly string[]).includes(v);

export function readLineSelection(search: Search): LineSelection {
  const view = search?.get("view");
  return {
    view: isView(view) ? view : DEFAULT_LINE_VIEW,
    graph: search?.get("graph") || null,
    step: search?.get("step") || null,
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
    if (patch.run === undefined) q.delete("run");
  }
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

/** The map's own keys: a link carrying one asks for the map, not the workspace. */
const MAP_KEYS = ["node", "edge", "trace", "section", "station", "window"] as const;
/** What /line lists rather than one project's line. */
const NOT_ONE_LINE = new Set(["all", "none"]);

/**
 * Where an old `/line?project=<p>` address goes now: one project's line is
 * its workspace, `/line/<p>`, keeping the graph it named. An address that opens
 * a panel, a window or a trace on the map stays on the map, and the overview
 * (no project, all of them, or the causes under none) stays where it is. Null
 * when the address stays.
 */
export function lineWorkspaceRedirect(search: Search): string | null {
  const project = search?.get("project")?.trim();
  if (!project || NOT_ONE_LINE.has(project)) return null;
  if (MAP_KEYS.some((k) => search?.get(k))) return null;
  return lineWorkspaceHref(project, { graph: search?.get("graph") || null });
}
