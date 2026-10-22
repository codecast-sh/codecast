// The `flow` fenced block's spec, and a flow run's state in words
// (docs/architecture/flows.md FL6). Pure: components/line/widgets/FlowFence draws it.
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import type { ShippedFlow } from "./flowPool";

export const FLOW_FENCE_LANG = "flow";

export type FlowFenceSpec = { flow: string | null; run: string | null; title: string | null };
export type FlowFenceRead = { ok: true; spec: FlowFenceSpec } | { ok: false; why: string };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A fence's body as a spec: `{"flow":"<slug>"}` or `{"run":"<run id>"}`, with an optional `title`. */
export function readFlowFence(code: string): FlowFenceRead {
  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    return { ok: false, why: "The block is not JSON." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, why: "The block is not a JSON object." };
  const o = raw as Record<string, unknown>;
  const spec = { flow: str(o.flow), run: str(o.run), title: str(o.title) };
  if (!spec.flow && !spec.run) return { ok: false, why: "Name a flow or a run." };
  return { ok: true, spec };
}

export type FlowRunTone = "running" | "waiting" | "passed" | "stopped" | "failed";

type RunLike = {
  node_statuses?: ReadonlyArray<{ node_id: string; status: string }> | null;
  status: string;
  current_node_id?: string | null;
  fail_reason?: string | null;
  gate_prompt?: string | null;
};

/** Where a run of a flow stands, in a few words, and the station's own words when it stopped. */
export function flowRunState(run: RunLike, flow: Pick<ShippedFlow, "nodes">): { tone: FlowRunTone; words: string; why: string | null } {
  const label = (id: string | null | undefined) => {
    if (!id) return null;
    const n = flow.nodes.find((x) => x.id === id);
    const top = flow.nodes.find((x) => x.id === segmentTopOf(id));
    return n ? (top && top.id !== n.id && top.label !== n.label ? `${top.label}: ${n.label}` : n.label) : id;
  };
  const at = label(run.current_node_id);
  // A run that ended on one of the flow's ends is said by that end's own name ("Passed", "Checks failed").
  const end = flow.nodes.find((n) => n.id === run.current_node_id && (n.type === "exit" || !!n.segment_exit))?.label ?? null;
  const stop = run.fail_reason?.replace(/^Stopped:\s*/, "") ?? null;
  switch (run.status) {
    case "completed": return { tone: "passed", words: end ?? (at ? `Done at ${at}` : "Done"), why: null };
    case "paused": return { tone: "waiting", words: at ? `Waiting at ${at}` : "Waiting on a person", why: run.gate_prompt?.split("\n")[0] ?? null };
    case "failed": return run.fail_reason?.startsWith("Stopped")
      ? { tone: "stopped", words: end ?? (at ? `Stopped at ${at}` : "Stopped"), why: stop }
      : { tone: "failed", words: at ? `Failed at ${at}` : "Failed", why: stop };
    case "pending": return { tone: "running", words: "Starting", why: null };
    default: return { tone: "running", words: at ? `At ${at}` : "Running", why: null };
  }
}
