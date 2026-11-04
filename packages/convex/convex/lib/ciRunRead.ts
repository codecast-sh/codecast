// What a GitHub Actions run says about itself, read from the REST answers
// into the shape ci_run_details keeps (ciRuns.ts). Pure, so the shapes and
// the log tail are tested without GitHub.

export type CiStep = { number: number; name: string; conclusion?: string };
export type CiJob = { id: string; name: string; conclusion?: string; duration_ms?: number; url?: string; steps: CiStep[] };
export type CiAnnotation = { job: string; level: string; message: string; title?: string; path?: string; line?: number };

/** Jobs a run keeps, and steps per job: a matrix run can carry hundreds. */
export const CI_JOBS_MAX = 40;
export const CI_STEPS_MAX = 60;
export const CI_ANNOTATIONS_MAX = 20;
/** The log tail a run keeps, in lines and bytes. */
export const CI_LOG_LINES = 60;
export const CI_LOG_BYTES = 8000;

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export function isFailedConclusion(c: string | null | undefined): boolean {
  return !!c && FAILED.has(c);
}

const ms = (s: unknown): number | undefined => {
  const t = typeof s === "string" ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

const str = (s: unknown, max = 300): string | undefined => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined);

/** The run's own facts: its title (the commit's first line), event, actor, attempt, start and how long it took. */
export function readRun(run: any): { title?: string; event?: string; actor?: string; attempt?: number; started_at?: number; duration_ms?: number } {
  const started = ms(run?.run_started_at) ?? ms(run?.created_at);
  const ended = ms(run?.updated_at);
  return {
    title: str(run?.display_title ?? run?.head_commit?.message?.split("\n")[0]),
    event: str(run?.event, 40),
    actor: str(run?.triggering_actor?.login ?? run?.actor?.login, 80),
    attempt: typeof run?.run_attempt === "number" ? run.run_attempt : undefined,
    started_at: started,
    duration_ms: started !== undefined && ended !== undefined && ended >= started ? ended - started : undefined,
  };
}

/** The jobs of a run, failed first, each with its steps. */
export function readJobs(answer: any): CiJob[] {
  const jobs: CiJob[] = (Array.isArray(answer?.jobs) ? answer.jobs : []).map((j: any) => {
    const started = ms(j?.started_at);
    const ended = ms(j?.completed_at);
    return {
      id: String(j?.id ?? ""),
      name: str(j?.name, 200) ?? "job",
      conclusion: str(j?.conclusion, 40),
      duration_ms: started !== undefined && ended !== undefined && ended >= started ? ended - started : undefined,
      url: str(j?.html_url, 500),
      steps: (Array.isArray(j?.steps) ? j.steps : []).slice(0, CI_STEPS_MAX).map((s: any) => ({
        number: typeof s?.number === "number" ? s.number : 0,
        name: str(s?.name, 200) ?? "step",
        conclusion: str(s?.conclusion, 40),
      })),
    };
  }).filter((j: CiJob) => j.id);
  const rank = (j: CiJob) => (isFailedConclusion(j.conclusion) ? 0 : j.conclusion === "cancelled" ? 1 : 2);
  return jobs.sort((a, b) => rank(a) - rank(b)).slice(0, CI_JOBS_MAX);
}

/** A check run's annotations as the run keeps them; notices are left out. */
export function readAnnotations(job: string, answer: any): CiAnnotation[] {
  return (Array.isArray(answer) ? answer : [])
    .filter((a: any) => a?.annotation_level !== "notice" && typeof a?.message === "string")
    .map((a: any) => ({
      job,
      level: str(a.annotation_level, 20) ?? "failure",
      message: String(a.message).slice(0, 1200),
      title: str(a.title, 200),
      // ".github" is where a runner-level failure points: no file at all.
      path: a.path === ".github" ? undefined : str(a.path, 300),
      line: typeof a.start_line === "number" ? a.start_line : undefined,
    }));
}

const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The last lines of a job's log that explain it: the lines up to and around
 * its last `##[error]`, else its end. Timestamps, colour codes and GitHub's
 * group markers are dropped; at most CI_LOG_LINES lines and CI_LOG_BYTES.
 */
export function logTail(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.replace(STAMP, "").replace(ANSI, "")).filter((l) => !/^##\[(end)?group\]/.test(l));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("##[error]")) {
      // GitHub's error mark closes the failed step; what follows is the next step (cleanup, a notifier).
      end = i + 1;
      break;
    }
  }
  const picked = lines.slice(Math.max(0, end - CI_LOG_LINES), end);
  let out = picked.join("\n");
  if (out.length > CI_LOG_BYTES) out = out.slice(out.length - CI_LOG_BYTES).replace(/^[^\n]*\n/, "");
  return out;
}
