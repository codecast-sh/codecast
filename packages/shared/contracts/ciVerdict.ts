// The verdict our own CI runner leaves for one commit (ct-102083): `verdict.json` plus `jobs/<job>.log` in one
// directory, written by Union's runner and read by `cast ci record`. Version 1; a change to it is agreed with the
// runner's side first.

import type { CiFailure } from "./ciFailures";

export type RunnerJobConclusion = "success" | "failure" | "skipped" | "infra";

export interface RunnerVerdictJob {
  name: string;
  /** Whether the job decides the run's conclusion (prompt-guard and build-image do not, on main). */
  counts: boolean;
  conclusion: RunnerJobConclusion;
  seconds: number;
  failing: CiFailure[];
  /** The job's log, relative to verdict.json's directory. */
  log?: string;
  note?: string;
}

export interface RunnerVerdict {
  version: 1;
  repository: string;
  sha: string;
  name: string;
  kind: "main" | "landing";
  host: string;
  run_id: string;
  started_at: number;
  finished_at?: number;
  status: "in_progress" | "completed";
  conclusion?: "success" | "failure" | "infra";
  jobs: RunnerVerdictJob[];
}

const JOB_CONCLUSIONS = new Set(["success", "failure", "skipped", "infra"]);
const nullableString = (x: unknown) => x === null || typeof x === "string";

/** The verdict a parsed verdict.json holds, or every way it breaks the contract. */
export function parseRunnerVerdict(raw: unknown): { verdict: RunnerVerdict } | { problems: string[] } {
  const v = raw as any;
  const problems: string[] = [];
  const need = (ok: boolean, what: string) => { if (!ok) problems.push(what); };
  if (!v || typeof v !== "object") return { problems: ["verdict.json is not an object"] };
  need(v.version === 1, "version must be 1");
  need(typeof v.repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(v.repository), "repository must be owner/name");
  need(typeof v.sha === "string" && /^[0-9a-f]{40}$/i.test(v.sha), "sha must be 40 hex characters");
  for (const k of ["name", "host", "run_id"]) need(typeof v[k] === "string" && v[k].length > 0, `${k} must be a non-empty string`);
  need(v.kind === "main" || v.kind === "landing", "kind must be main or landing");
  need(Number.isFinite(v.started_at), "started_at must be a number (ms)");
  need(v.finished_at === undefined || v.finished_at === null || Number.isFinite(v.finished_at), "finished_at must be a number (ms)");
  need(v.status === "in_progress" || v.status === "completed", "status must be in_progress or completed");
  need(v.status !== "completed" || ["success", "failure", "infra"].includes(v.conclusion), "a completed verdict needs conclusion success, failure or infra");
  need(Array.isArray(v.jobs), "jobs must be an array");
  for (const [i, j] of (Array.isArray(v.jobs) ? v.jobs : []).entries()) {
    const at = `jobs[${i}]`;
    need(typeof j?.name === "string" && /^[\w.-]+$/.test(j.name), `${at}.name must be a job name`);
    need(typeof j?.counts === "boolean", `${at}.counts must be true or false`);
    need(JOB_CONCLUSIONS.has(j?.conclusion), `${at}.conclusion must be success, failure, skipped or infra`);
    need(Number.isFinite(j?.seconds), `${at}.seconds must be a number`);
    need(j?.log === undefined || (typeof j.log === "string" && !j.log.split("/").includes("..")), `${at}.log must be a path inside the verdict's directory`);
    need(j?.note === undefined || typeof j.note === "string", `${at}.note must be a string`);
    const failing = j?.failing ?? [];
    need(Array.isArray(failing), `${at}.failing must be an array`);
    for (const [k, f] of (Array.isArray(failing) ? failing : []).entries()) {
      const ok = f && typeof f.job === "string" && nullableString(f.test) && nullableString(f.assertion) && nullableString(f.file)
        && (f.line === null || Number.isFinite(f.line)) && typeof f.excerpt === "string";
      need(!!ok, `${at}.failing[${k}] must be a CiFailure`);
    }
  }
  if (problems.length) return { problems };
  const jobs: RunnerVerdictJob[] = v.jobs.map((j: any) => ({
    name: j.name, counts: j.counts, conclusion: j.conclusion, seconds: j.seconds,
    failing: (j.failing ?? []).map((f: any) => ({ job: f.job, test: f.test, assertion: f.assertion, file: f.file, line: f.line, excerpt: f.excerpt })),
    ...(j.log ? { log: j.log } : {}), ...(j.note ? { note: j.note } : {}),
  }));
  return {
    verdict: {
      version: 1, repository: v.repository, sha: v.sha.toLowerCase(), name: v.name, kind: v.kind, host: v.host, run_id: v.run_id,
      started_at: v.started_at, ...(Number.isFinite(v.finished_at) ? { finished_at: v.finished_at } : {}),
      status: v.status, ...(v.conclusion ? { conclusion: v.conclusion } : {}), jobs,
    },
  };
}

/** How much of a job's log codecast keeps: its tail, before gzip. */
export const RUNNER_LOG_TAIL_BYTES = 2 * 1024 * 1024;

/** The last `max` bytes of a log, cut at a line start, with a line saying how much went before. */
export function logTail(log: Uint8Array, max = RUNNER_LOG_TAIL_BYTES): Uint8Array {
  if (log.length <= max) return log;
  let from = log.length - max;
  const nl = log.indexOf(10, from);
  if (nl >= 0 && nl < log.length - 1) from = nl + 1;
  const head = new TextEncoder().encode(`[codecast kept the last ${log.length - from} of ${log.length} bytes]\n`);
  const out = new Uint8Array(head.length + log.length - from);
  out.set(head, 0);
  out.set(log.subarray(from), head.length);
  return out;
}
