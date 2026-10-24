// Which graph a problem runs when its team has a live flow (liveFlows.ts):
// one from the live flow's family, whoever runs it. The family is the flow
// the live flow names (the spine), the flows in its workspace that extend
// it (its variants), and the library flow in its workspace that serves
// judge-review (its judge route, a graph of its own). A problem takes the member whose `serves` names its
// source, the newest when two do, else the spine. A problem of cases against
// a judge (isJudgeProblem) takes the member that serves judge-review, the
// judge route (learning-loop.md LL11), and never the spine: a family with no
// such member leaves it queued, and its route says so. A team with no live
// flow, or one that is off, keeps the runner's own versions
// (workflows.lineRouteFor).
//
// Pure, so the run start (workflows.lineRouteFor), the sweep's admission
// (liveFlows.planLiveFlow) and the flow map name each problem's lane alike.
import { flowGraphAttr } from "@codecast/shared/contracts/flowPool";
import { JUDGE_CASE_SOURCE } from "@codecast/shared/contracts/judgeReview";

/** The fields of a workflows row the route reads. */
export type FlowRouteRow = {
  _id: string;
  slug: string;
  source?: string | null;
  serves?: string[] | null;
  origin?: { file?: string } | null;
  updated_at?: number;
  runs_from?: "library" | "repo" | null;
};

export type FlowRouteFlow = { _id: string; workflow_id: string; on: boolean };

/**
 * serves: a member names the problem's source. spine: no member does. judge:
 * a problem of cases, to the member serving judge-review; `workflow` is null
 * when the family has none, and the problem waits.
 */
export type FlowLane = "serves" | "spine" | "judge";
export type FlowRoute<W extends FlowRouteRow = FlowRouteRow> =
  | { live_flow_id: string; lane: FlowLane; workflow: W; waiting: null }
  | { live_flow_id: string; lane: "judge"; workflow: null; waiting: string };

/** What a judge problem's route says while its family has no judge member. */
export const NO_JUDGE_FLOW = "no judge flow";

/** An `extends` that names a file (a path, or a .cast), not a library flow by slug. */
export const isExtendsPath = (ext: string) => ext.includes("/") || ext.endsWith(".cast");

/** The checkout file an `extends` path names, read from the row's own file; null for none or a slug. */
export function extendsFile(row: Pick<FlowRouteRow, "source" | "origin">): string | null {
  const ext = flowGraphAttr(row.source, "extends");
  if (!ext || !isExtendsPath(ext) || !row.origin?.file) return null;
  const parts = row.origin.file.split("/").slice(0, -1);
  for (const p of ext.split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/** Whether `row` extends `base`: by its slug, or by its checkout file. */
export function extendsFlow(row: FlowRouteRow, base: FlowRouteRow): boolean {
  if (String(row._id) === String(base._id)) return false;
  const ext = flowGraphAttr(row.source, "extends");
  if (!ext) return false;
  if (!isExtendsPath(ext)) return ext === base.slug;
  return !!base.origin?.file && extendsFile(row) === base.origin.file;
}

/** The family, from the rows of the flow's workspace: the spine first, then its variants and its judge route. */
export function flowFamily<W extends FlowRouteRow>(spine: W, rows: W[]): W[] {
  const judgeRoute = (r: W) => r.runs_from === "library" && (r.serves ?? []).includes(JUDGE_CASE_SOURCE);
  return [spine, ...rows.filter((r) => String(r._id) !== String(spine._id) && (extendsFlow(r, spine) || judgeRoute(r)))];
}

const newestServing = <W extends FlowRouteRow>(family: W[], source: string): W | null =>
  family.filter((w) => (w.serves ?? []).includes(source)).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0] ?? null;

/**
 * The route of a problem under its workspace's live flow, or null when the
 * flow is missing or off, or its spine row is gone: the caller then keeps
 * the runner's own versions. `source` is the problem's first finding's,
 * lowercased (null for a task that is no problem, which runs the spine);
 * `judge` is isJudgeProblem on its cause.
 */
export function flowRouteFor<W extends FlowRouteRow>(o: { flow: FlowRouteFlow | null | undefined; spine: W | null | undefined; rows: W[]; source: string | null | undefined; judge: boolean }): FlowRoute<W> | null {
  const { flow, spine } = o;
  if (!flow?.on || !spine || String(spine._id) !== String(flow.workflow_id)) return null;
  const family = flowFamily(spine, o.rows);
  const live_flow_id = String(flow._id);
  if (o.judge) {
    const judge = newestServing(family, JUDGE_CASE_SOURCE);
    return judge ? { live_flow_id, lane: "judge", workflow: judge, waiting: null } : { live_flow_id, lane: "judge", workflow: null, waiting: NO_JUDGE_FLOW };
  }
  const source = o.source?.trim().toLowerCase();
  const serving = source ? newestServing(family, source) : null;
  return serving ? { live_flow_id, lane: "serves", workflow: serving, waiting: null } : { live_flow_id, lane: "spine", workflow: spine, waiting: null };
}
