export type SchedAccent = "running" | "attention" | "paused" | "normal";
export function schedAccent(task: { status: string; last_run_failed?: boolean; last_run_needs_attention?: boolean }): SchedAccent {
  if (task.status === "running") return "running";
  if (task.status === "failed" || task.last_run_failed || task.last_run_needs_attention) return "attention";
  if (task.status === "paused" || task.status === "completed") return "paused";
  return "normal";
}
