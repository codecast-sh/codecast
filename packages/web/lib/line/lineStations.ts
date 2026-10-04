// A project's line stations (plan pl-838 step 3): the shipped `line` graph
// read-only, and a project's customized copy as one of the viewer's workflows
// (`workflows` row, slug `line-<project>`), which a role's line picker then
// selects. Only a station's prompt, script and timeout are edited here; the
// graph's shape stays the shipped one, so "reset" always has a station to
// read back from. Pure, so the fork, diff and reset rules test without React.
import { DEFAULT_LINE_SLUG, LINE_SLUG_RE } from "@codecast/shared/contracts/orgProposal";

export type LineNode = {
  id: string;
  label: string;
  shape: string;
  type: string;
  prompt?: string;
  script?: string;
  timeout?: number;
  [attr: string]: unknown;
};

export type LineEdge = { from: string; to: string; label?: string; condition?: string };

/** The parsed shipped template (shippedLine.generated.ts). `files` names the
 *  template file a station's prompt or script ships in. */
export type ShippedLine = {
  name: string;
  goal?: string;
  stack?: string;
  source: string;
  nodes: LineNode[];
  edges: LineEdge[];
  files: Record<string, { prompt?: string; script?: string }>;
};

/** What `workflows.webUpsert` takes and a `workflows` row carries. */
export type LineWorkflow = {
  slug: string;
  name: string;
  goal?: string;
  source?: string;
  nodes: LineNode[];
  edges: LineEdge[];
};

export const STATION_FIELDS = ["prompt", "script", "timeout"] as const;
export type StationField = (typeof STATION_FIELDS)[number];
export type StationPatch = { prompt?: string | null; script?: string | null; timeout?: number | null };

/** The project's customized line: one stable slug per project, from its short
 *  id (its row id when it has none), always a valid line slug. */
export function lineForkSlug(project: { _id: string; short_id?: string | null }): string {
  const key = (project.short_id || project._id).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const slug = `${DEFAULT_LINE_SLUG}-${key}`.slice(0, 64).replace(/-+$/, "");
  return LINE_SLUG_RE.test(slug) ? slug : DEFAULT_LINE_SLUG;
}

const cloneNodes = (nodes: LineNode[]): LineNode[] => nodes.map((n) => ({ ...n }));
const cloneEdges = (edges: LineEdge[]): LineEdge[] => edges.map((e) => ({ ...e }));

/** The shipped line as the project's own workflow, ready for webUpsert. */
export function forkShippedLine(shipped: ShippedLine, project: { _id: string; short_id?: string | null; title?: string | null }): LineWorkflow {
  return {
    slug: lineForkSlug(project),
    name: project.title ? `Line for ${project.title}` : "Line",
    ...(shipped.goal ? { goal: shipped.goal } : {}),
    // The raw template: a pushed row reads its graph attributes (the stack)
    // back from `source` (cli daemonGraph.ts), and the nodes carry the text.
    source: shipped.source,
    nodes: cloneNodes(shipped.nodes),
    edges: cloneEdges(shipped.edges),
  };
}

const same = (a: unknown, b: unknown) => (a ?? undefined) === (b ?? undefined);

/** The station fields where `node` differs from the shipped station. A station
 *  the shipped line lacks differs in every field it sets. */
export function stationChanges(node: LineNode, shippedNode: LineNode | undefined): StationField[] {
  return STATION_FIELDS.filter((f) => !same(node[f], shippedNode?.[f]));
}

/** Every station of `nodes` that differs from shipped, with the fields. */
export function stationDiffs(nodes: LineNode[], shipped: ShippedLine): Record<string, StationField[]> {
  const byId = new Map(shipped.nodes.map((n) => [n.id, n]));
  const out: Record<string, StationField[]> = {};
  for (const n of nodes) {
    const changed = stationChanges(n, byId.get(n.id));
    if (changed.length > 0) out[n.id] = changed;
  }
  return out;
}

/** A station's fields set from `patch`; null, an empty text or a non-positive
 *  timeout removes the field. Other stations keep their object identity. */
export function editStation(nodes: LineNode[], id: string, patch: StationPatch): LineNode[] {
  return nodes.map((n) => {
    if (n.id !== id) return n;
    const next: LineNode = { ...n };
    for (const f of STATION_FIELDS) {
      if (!(f in patch)) continue;
      const v = patch[f];
      const empty = v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (typeof v === "number" && !(v > 0));
      if (empty) delete next[f];
      else (next as any)[f] = v;
    }
    return next;
  });
}

/** A station put back to its shipped prompt, script and timeout. */
export function resetStation(nodes: LineNode[], id: string, shipped: ShippedLine): LineNode[] {
  const s = shipped.nodes.find((n) => n.id === id);
  if (!s) return nodes;
  return editStation(nodes, id, { prompt: s.prompt ?? null, script: s.script ?? null, timeout: s.timeout ?? null });
}

/** The whole line put back to shipped: nodes and edges. */
export function resetAllStations(shipped: ShippedLine): Pick<LineWorkflow, "nodes" | "edges"> {
  return { nodes: cloneNodes(shipped.nodes), edges: cloneEdges(shipped.edges) };
}

/** What clicking a station opens: its prompt or its script, and the shipped
 *  template file it comes from when the shipped line names one. */
export function stationText(node: LineNode, shipped: ShippedLine): { kind: "prompt" | "script" | null; text: string; file?: string } {
  const files = shipped.files[node.id];
  if (node.script !== undefined || (node.prompt === undefined && files?.script)) {
    return { kind: "script", text: node.script ?? "", ...(files?.script ? { file: files.script } : {}) };
  }
  if (node.prompt !== undefined || files?.prompt) {
    return { kind: "prompt", text: node.prompt ?? "", ...(files?.prompt ? { file: files.prompt } : {}) };
  }
  return { kind: null, text: "" };
}

/** Start, exit and conditionals carry nothing to read or edit. */
export const isEditableStation = (node: LineNode) => node.type !== "start" && node.type !== "exit" && node.type !== "conditional";

type ScopedRole = {
  _id: string;
  status?: string;
  host_user_id?: string;
  scope: { project_ids: string[] };
  line_workflow_slug?: string | null;
};

/** The roles whose area holds the project, and the line each runs. */
export function rolesOnProject<R extends ScopedRole>(roles: R[], projectId: string): Array<{ role: R; slug: string }> {
  return roles
    .filter((r) => r.status !== "retired" && r.scope.project_ids.includes(projectId))
    .map((role) => ({ role, slug: role.line_workflow_slug || DEFAULT_LINE_SLUG }));
}
