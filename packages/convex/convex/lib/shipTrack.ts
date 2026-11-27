// What the Shipping column reads off a run beside its station statuses (workflow_runs.shippingRuns): the personal
// flow's Check verdict and how the run lands its change. A leaf: it imports only types.
import type { Doc } from "../_generated/dataModel";

/**
 * The personal flow's Check verdict (cli workflow/personalCheck.ts, check.json): pass or skipped is green, fail is not.
 * Read from the `check` station's pinned result once it completed; a long result is cut, so its outcome is read by
 * pattern. Null when the run has no such station or no result yet.
 */
export function checkVerdictOf(run: Pick<Doc<"workflow_runs">, "node_statuses">): { green: boolean; at: number } | null {
  const n = run.node_statuses.find((x) => x.node_id === "check");
  if (!n || n.status !== "completed" || !n.result_preview) return null;
  let outcome: unknown;
  try { outcome = JSON.parse(n.result_preview)?.outcome; } catch { outcome = n.result_preview.match(/"outcome"\s*:\s*"(pass|fail|skipped)"/)?.[1]; }
  if (outcome !== "pass" && outcome !== "fail" && outcome !== "skipped") return null;
  return { green: outcome !== "fail", at: n.completed_at ?? 0 };
}

/**
 * How a run lands its change. A run in a flow's direct mode (the library change flow's ship_mode=direct: its
 * `direct_*` stations) lands direct. Otherwise its graph decides, so a run reads it before it reaches the station:
 * "pr" when the graph has a `pr` station at any depth (`pr`, `land__pr`) or a segment that is the `land` flow
 * (Union's), else "direct".
 */
export function shipTrackOf(
  wf: { nodes?: Array<{ id: string }>; source?: string } | null | undefined,
  run?: Pick<Doc<"workflow_runs">, "node_statuses">,
): "pr" | "direct" {
  if (run?.node_statuses.some((n) => n.node_id.startsWith("direct_"))) return "direct";
  if ((wf?.nodes ?? []).some((n) => n.id === "pr" || n.id.endsWith("__pr"))) return "pr";
  const source = wf?.source ?? "";
  return /(^|[\s;{])pr\s*\[/m.test(source) || /\bflow\s*=\s*"?land"?(?![\w-])/.test(source) ? "pr" : "direct";
}
