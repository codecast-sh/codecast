// A CI run read back from GitHub (opsCiRuns), as the issue page and a fix
// session read it: which jobs failed and at which step, and the failure as
// one block of evidence for the fix prompt.
import type { OpsCiRun } from "./opsTypes";

type Job = OpsCiRun["jobs"][number];

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export function jobFailed(job: Pick<Job, "conclusion">): boolean {
  return !!job.conclusion && FAILED.has(job.conclusion);
}

/** The step a failed job stopped at: its first failed step, else none named. */
export function failedStep(job: Job): Job["steps"][number] | null {
  return job.steps.find((s) => s.conclusion && FAILED.has(s.conclusion)) ?? null;
}

/** The run's jobs split the way the card shows them: failed ones whole, the rest as a count by how they ended. */
export function runJobs(run: Pick<OpsCiRun, "jobs">): { failed: Job[]; passed: number; other: number } {
  const failed = run.jobs.filter(jobFailed);
  const passed = run.jobs.filter((j) => j.conclusion === "success").length;
  return { failed, passed, other: run.jobs.length - failed.length - passed };
}

/** The lines of a log tail that are GitHub's own error marks. */
export function isErrorLine(line: string): boolean {
  return line.startsWith("##[error]");
}

const EXPLAINS = /^\s*(?:Error|ERROR|error|Fatal|FATAL|fatal)\b[:\s]|^\s*(?:FAIL|Failed|failed)\b|^\s*npm ERR!|^\s*(?:✗|×|✘)\s|\bCannot\s|\bTraceback\b/;

/**
 * The line a reader looks for first: the first that says what went wrong
 * ("Error: …", "FAIL …", "Cannot …"), else the first error mark. Its index in
 * `lines`, or -1.
 */
export function firstFailureLine(lines: readonly string[]): number {
  const said = lines.findIndex((l) => !isErrorLine(l) && EXPLAINS.test(l));
  return said >= 0 ? said : lines.findIndex(isErrorLine);
}

/** A line that says something failed, marked or not: the log draws it red. */
export function isFailureLine(line: string): boolean {
  return isErrorLine(line) || EXPLAINS.test(line);
}

/** A log tail's lines up to its last error mark: what follows is the next step, not the failure. */
export function tailLines(tail: string | undefined): string[] {
  const lines = tail ? tail.split("\n") : [];
  let last = -1;
  lines.forEach((l, i) => { if (isErrorLine(l)) last = i; });
  return last >= 0 ? lines.slice(0, last + 1) : lines;
}

/** A runner-level annotation points at ".github": no file to name. */
export function annotationPath(path: string | undefined): string | undefined {
  return path && path !== ".github" ? path : undefined;
}

/** How many lines of the tail the card shows before "Whole tail". */
export const LOG_LINES_SHOWN = 14;

/**
 * The run's failure as a fix session reads it: the failed jobs and steps,
 * the annotations, then the log tail. Plain text; the prompt fences it as
 * untrusted (opsModel fixPrompt).
 */
export function ciFailureText(run: OpsCiRun): string | null {
  const { failed } = runJobs(run);
  const lines: string[] = [];
  if (run.title) lines.push(`run: ${run.title}`);
  for (const j of failed) {
    const step = failedStep(j);
    lines.push(`job ${j.name} ${j.conclusion}${step ? ` at step ${step.number} "${step.name}"` : ""}`);
  }
  for (const a of run.annotations.slice(0, 8)) {
    const path = annotationPath(a.path);
    lines.push(`${path ? `${path}${a.line ? `:${a.line}` : ""} ` : ""}${a.title ? `${a.title}: ` : ""}${a.message}`);
  }
  const tail = tailLines(run.log_tail);
  if (tail.length) lines.push(`log tail${run.log_job ? ` (${run.log_job})` : ""}:`, tail.join("\n"));
  return lines.length ? lines.join("\n") : null;
}

/** Steps that set the machine up rather than run the project's code. */
const SETUP_STEP = /^(set up|setup|install|initiali[sz]e|checkout|cache|restore|download|pull|login|configure|run actions\/(setup|checkout|cache))\b/i;
/** Log lines that blame the machine, not the commit: an unsupported OS image, a full disk, the network, the runner itself. */
const ENV_LINE = /(does not support \S+ on \S+|unsupported (platform|os)|no space left on device|runner (has received a shutdown|lost communication)|ETIMEDOUT|ECONNRESET|EAI_AGAIN|rate limit exceeded|503 Service Unavailable|could not resolve host)/i;

/**
 * Why a run failed when the cause is the machine it ran on and not a commit:
 * a setup step failing, or the log naming the runner, its OS image or the
 * network. `image` is the runner image the log names (ubuntu26.04), when it
 * names one. Null when the failure reads as the code's.
 */
export function envFailure(run: Pick<OpsCiRun, "jobs" | "log_tail">): { step: string | null; image: string | null } | null {
  const job = run.jobs.find(jobFailed);
  const step = job ? failedStep(job) : null;
  const lines = tailLines(run.log_tail);
  const blamed = lines.find((l) => ENV_LINE.test(l)) ?? null;
  if (!blamed && !(step && SETUP_STEP.test(step.name))) return null;
  const image = (blamed ?? lines.join("\n")).match(/\b((?:ubuntu|macos|windows)-?\d+(?:\.\d+)?)/i)?.[1] ?? null;
  return { step: step?.name ?? null, image };
}
