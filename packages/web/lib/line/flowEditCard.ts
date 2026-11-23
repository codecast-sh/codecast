// A `cast flow edit` drawn in a transcript (docs/architecture/pipeline.md PL5):
// the edit in words, the flow it builds with this edit's stations marked (a
// skipped one as a ghost where it stood), and which of the session's change
// runs carries it. The edit fence carries the flow as it validated (FlowEdit
// graph); an older fence without one draws over the library's backbone with
// the file's edits laid on. Pure: the web card (FlowEditCard) and the phone's
// FlowCard both read it. Reading an edit out of a fence or a command's output
// is lib/line/flowEditFence.ts, kept off this module's import graph.
import { flowEditWords, type FlowEdit, type FlowEditChange } from "@codecast/shared/contracts/flowEdit";
import { foldFlow, segmentTopOf, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import { flowDiagram, type DiagramStep, type FlowDiagramModel, type StepMark } from "./flowDiagram";
import type { ShippedFlow } from "./flowPool";
import { whenWords } from "./pipelineModel";

/** A step's mark on the edit card: a station this edit takes off the path is `skipped`, `proposed` until it is live. */
export type EditMark = StepMark;

export type EditDrawing = { flow: ShippedFlow; diagram: FlowDiagramModel; marks: Record<string, EditMark> };

type Graph = { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> };

const titleOf = (id: string) => id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** The flow's name as a person says it: the pipeline's label for it when known, else its slug's ("change" is Change). */
export const editFlowLabel = (edit: Pick<FlowEdit, "flow">, known?: string | null) => known || titleOf(edit.flow);

/** A station's name in the edit's flow: the change's own label, else the graph's, else its id read as words. */
function labeler(edit: FlowEdit, graph: Graph | null) {
  const named = new Map<string, string>();
  for (const c of [...(edit.variant ?? []), ...edit.changes]) if (c.label) named.set(c.station, c.label);
  return (id: string) => {
    const top = segmentTopOf(id);
    return named.get(id) ?? named.get(top) ?? graph?.nodes.find((n) => n.id === top)?.label ?? titleOf(top);
  };
}

/**
 * The edit in words, one line a station: "+ Lint after Check · runs when landing/**", "~ Review: guidance added",
 * "Decide skipped". A station added with a `when` reads as one line.
 */
export function editLines(edit: FlowEdit): string[] {
  const label = labeler(edit, edit.graph ?? null);
  const out: string[] = [];
  const added = new Map<string, number>();
  for (const c of edit.changes) {
    const at = added.get(c.station);
    if (c.op === "when" && at !== undefined) {
      out[at] += c.paths?.length ? ` · runs when ${c.paths.join(", ")}` : "";
      continue;
    }
    if (c.op === "add") added.set(c.station, out.length);
    out.push(flowEditWords(c, label));
  }
  return out;
}

const KIND_OF_WHO: Record<NonNullable<FlowEditChange["who"]>, DiagramStep["kind"]> = { agent: "agent", command: "script", person: "person" };

const allSteps = (steps: DiagramStep[]): DiagramStep[] => steps.flatMap((s) => [s, ...allSteps(s.inner)]);
/** The top-level step a station sits in (a segment's step is in its frame). */
const topIndex = (steps: DiagramStep[], id: string) => steps.findIndex((s) => s.id === id || allSteps(s.inner).some((x) => x.id === id));

/** A step put on the path after (or before) the station it names, failing the way that station fails. */
function placed(steps: DiagramStep[], step: DiagramStep, after?: string, before?: string): DiagramStep[] {
  if (topIndex(steps, step.id) >= 0) return steps;
  const anchor = topIndex(steps, (after ?? before) ?? "");
  const at = anchor < 0 ? (after ? steps.length : 0) : before ? anchor : anchor + 1;
  return [...steps.slice(0, at), step, ...steps.slice(at)];
}

const asFlow = (edit: FlowEdit, g: Graph, label: string): ShippedFlow => ({
  slug: edit.flow, name: edit.flow, kind: "line", label, description: null, takes: [],
  ...foldFlow(g.nodes, g.edges), nodes: [...g.nodes], edges: [...g.edges],
});

/** What this edit says on each station it touched. `live`: the edit is out, so nothing is drawn as a proposal. */
function marksOf(edit: FlowEdit, diagram: FlowDiagramModel, live: boolean): Record<string, EditMark> {
  const drawn = new Set(allSteps(diagram.steps).map((s) => s.id));
  // A change to a segment's own step marks that step when it is drawn, else its frame.
  const key = (id: string) => (drawn.has(id) ? id : segmentTopOf(id));
  const marks: Record<string, EditMark> = {};
  const mark = (id: string, m: Partial<EditMark>) => {
    const k = key(id);
    const was = marks[k] ?? { own: null };
    marks[k] = { ...was, ...m, ...(m.changed ? { changed: [...new Set([...(was.changed ?? []), ...m.changed])] } : {}), own: was.own === "added" ? "added" : m.own ?? was.own };
  };
  const WHAT: Partial<Record<FlowEditChange["op"], string>> = { guide: "guidance", prompt: "prompt", run: "command" };
  for (const c of edit.changes) {
    if (c.op === "add") mark(c.station, { own: "added" });
    else if (c.op === "when") mark(c.station, { own: "changed", ...(whenWords(c.paths) ? { when: whenWords(c.paths)! } : {}), changed: ["when"] });
    else if (c.op === "skip" || (c.op === "undo" && c.added)) mark(c.station, { own: null, skipped: true, ...(live ? {} : { proposed: "proposed" }) });
    else if (WHAT[c.op]) mark(c.station, { own: "changed", changed: [WHAT[c.op]!] });
  }
  return marks;
}

/**
 * The flow the edit builds, drawn: its graph as it validated, or (an older fence) the backbone's with the file's edits
 * laid on. A station this edit skips comes back as a ghost where it stood. Null when there is neither graph nor backbone.
 */
export function editDrawing(edit: FlowEdit, opts: { base?: Graph | null; label?: string | null; live?: boolean } = {}): EditDrawing | null {
  const graph = edit.graph ?? opts.base ?? null;
  if (!graph) return null;
  const flow = asFlow(edit, graph, editFlowLabel(edit, opts.label));
  const label = labeler(edit, graph);
  const step = (c: FlowEditChange): DiagramStep => ({ id: c.station, label: label(c.station), kind: KIND_OF_WHO[c.who ?? "agent"], inner: [], side: [] });
  let steps = flowDiagram(flow).steps;
  const model = flowDiagram(flow);
  if (!edit.graph) {
    // The backbone knows nothing of the file: take off what it skips, put on what it adds, in the order written.
    const variant = edit.variant ?? edit.changes;
    const skipped = new Set(variant.filter((c) => c.op === "skip").map((c) => c.station));
    steps = steps.filter((s) => !skipped.has(s.id));
    for (const c of variant) if (c.op === "add") steps = placed(steps, step(c), c.after, c.before);
  }
  for (const c of edit.changes) if (c.op === "skip" || (c.op === "undo" && c.added)) steps = placed(steps.filter((s) => s.id !== c.station), step(c), c.after);
  const diagram: FlowDiagramModel = { ...model, steps };
  return { flow, diagram, marks: marksOf(edit, diagram, !!opts.live) };
}

type RunLike = { _id: string; graph_hash?: string | null; workflow_slug?: string | null; workflow_name?: string | null; created_at?: number };

/**
 * The session's change run that carries the edit: one that ran the graph the edit built, or one started after the edit
 * was made (the session's tree held it then). The newest wins. Null while the edit has shipped nowhere.
 */
export function editRun<R extends RunLike>(edit: Pick<FlowEdit, "graph_hash" | "flow">, runs: ReadonlyArray<R>, madeAt: number | null): R | null {
  let best: R | null = null;
  for (const r of runs) {
    const carries = (!!edit.graph_hash && r.graph_hash === edit.graph_hash) || (madeAt !== null && (r.created_at ?? 0) >= madeAt);
    if (carries && (!best || (r.created_at ?? 0) > (best.created_at ?? 0))) best = r;
  }
  return best;
}

/** The deploy a journey's line names live: "live on web dp-12" is dp-12. */
export const liveDeploy = (line: string | null | undefined) => line?.match(/\bdp-\d+\b/)?.[0] ?? null;

/** The CLI's patch (`--- a/<file>` / `+++ b/<file>` per file) with the `diff --git` line each file opens with, so the
 *  transcript's diff card (```cast-diff, lib/castDiff) splits it into one card per file and marks a new one added. */
export const asGitDiff = (diff: string) =>
  // A file the edit created starts from nothing (`@@ -1,0`): git says so with its mode line, and the card marks it added.
  diff.replace(/^--- a\/(.+)\n\+\+\+ b\/(.+)\n(?=(@@ -[01],0 )?)/gm, (all, a: string, b: string, created?: string) => `diff --git a/${a} b/${b}\n${created ? "new file mode 100644\n" : ""}${all}`);
