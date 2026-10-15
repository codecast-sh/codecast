/**
 * Where a cloud placement stands, written onto the conversation by the
 * laptop's `cast cloud start` child while it runs (cloud.reportPlacementProgress)
 * and read by the session's placement strip. Without it a placement is a
 * spinner for up to twenty minutes and then, at best, one error line naming a
 * step nobody saw start. Pure data; no runtime imports.
 */

/** The steps of a placement, in order. `launch` happens only when autoscale adds a host; a shared checkout skips `seed`. */
export const CLOUD_PLACEMENT_STEPS = ["host", "launch", "wake", "config", "checkout", "seed", "worktree", "start"] as const;
/** Steps a placement reaches only sometimes: shown once reached, never as a step still to come. */
export const CLOUD_PLACEMENT_OCCASIONAL_STEPS: ReadonlySet<string> = new Set(["launch"]);
export type CloudPlacementStep = (typeof CLOUD_PLACEMENT_STEPS)[number];

export const CLOUD_PLACEMENT_STEP_LABEL: Record<CloudPlacementStep, string> = {
  host: "Pick host",
  launch: "New host",
  wake: "Wake",
  config: "Agent config",
  checkout: "Repo",
  seed: "Your changes",
  worktree: "Worktree + install",
  start: "Start",
};

/** The most log lines a progress record keeps, and the longest one. */
export const CLOUD_PLACEMENT_LINES_MAX = 40;
export const CLOUD_PLACEMENT_LINE_CHARS = 240;

export interface CloudPlacementProgress {
  /** The park this belongs to (cloud_placement_token); a record from an older park is ignored. */
  token: string;
  /** The registry id of the host being prepared (an EC2 instance id). */
  host_id: string;
  /** Its codecast device, once known: the name and load the strip shows. */
  host_device_id?: string;
  /** The host the park asked for, when the placement went elsewhere, and why. */
  moved_from?: { host_id: string; host_device_id?: string; why: string };
  /** Each step reached, with when it began; the last is the current one. */
  steps: Array<{ step: CloudPlacementStep; at: number }>;
  started_at: number;
  /** The child's own progress lines, newest last. */
  lines: string[];
  /** Set by reportPlacementFailure: the last step is the one that failed. */
  failed_at?: number;
  at: number;
}
