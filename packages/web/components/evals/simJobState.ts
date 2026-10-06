// One mapping from a sim job (a shrink or a sweep) to what its page shows,
// shared by the run page and the catalog page. A page keeps the job it
// started in memory; after a reload it has only the api's newest job of that
// kind, and both paths go through jobState so they read the same.

import type { SimJob } from "@codecast/shared/contracts/evalsApi";
import { quietTooLong } from "@platform/evals/client";

export type JobState = { state: "idle" } | { state: "starting" } | { state: "running"; job: SimJob | null } | { state: "done"; job: SimJob } | { state: "failed"; error: string; logTail?: readonly string[] };

/** A job's state: running, done, or failed with its outcome and the last lines it printed. */
export function jobState(job: SimJob): JobState {
  if (job.status === "running") return { state: "running", job };
  if (job.status === "done") return { state: "done", job };
  return { state: "failed", error: `The ${job.kind} ${job.status}${job.progress.text ? `: ${job.progress.text}` : ""}`, logTail: job.logTail ?? [] };
}

/** What the page shows: its own job while it has one, else the newest job the api reports (the page was reloaded). */
export const shownJobState = (local: JobState, last: SimJob | null | undefined): JobState => (local.state !== "idle" || !last ? local : jobState(last));

export const jobLive = (s: JobState): boolean => s.state === "starting" || s.state === "running";

/** A running shrink or sweep with no new step for the stall window reads "stalled?", by the bisect's own rule. */
export const isJobStalled = (job: Pick<SimJob, "status" | "updatedAt">, now: number) => job.status === "running" && quietTooLong(job.updatedAt, now);
