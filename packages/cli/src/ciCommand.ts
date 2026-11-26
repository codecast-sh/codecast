// `cast ci`: our own CI runner's verdict per commit (ct-102083). `record` stores a run's verdict.json and the job
// logs beside it (each a gzipped tail in codecast's file storage); `show` and `log` read a commit's verdict back.
// In shadow nothing that decides a deploy reads these rows (ciRowDecides, shared/contracts/deployTargets.ts).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { Command } from "commander";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { checkoutRepository } from "./checkoutWords.js";
import { logTail, parseRunnerVerdict, type RunnerVerdict } from "@codecast/shared/contracts/ciVerdict";

const UPLOAD_TIMEOUT_MS = 120_000;

function repositoryOf(opt: string | undefined): string {
  const repo = opt ?? checkoutRepository(process.env.CODECAST_CWD || process.cwd());
  if (!repo) throw new Error("Not in a checkout with an origin remote; pass --repo owner/name.");
  return repo;
}

/** A job's log, its tail gzipped, uploaded to file storage: the storage id. */
async function uploadLog(deps: PublishDeps, file: string): Promise<string> {
  const body = zlib.gzipSync(logTail(fs.readFileSync(file)));
  const url = await apiPost(deps, "/cli/images/upload-url", {}, { exitOnError: false });
  if (typeof url !== "string") throw new Error("upload-url response malformed");
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/gzip" }, body: new Uint8Array(body), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`log upload failed: HTTP ${res.status}`);
  const { storageId } = (await res.json()) as { storageId?: string };
  if (!storageId) throw new Error("log upload returned no storage id");
  return storageId;
}

/** Read verdict.json, upload each job's log beside it, and store the verdict. */
export async function recordVerdict(deps: PublishDeps, file: string, log: (line: string) => void = console.log) {
  const parsed = parseRunnerVerdict(JSON.parse(fs.readFileSync(file, "utf-8")));
  if ("problems" in parsed) throw new Error(`${file} breaks the verdict contract:\n  ${parsed.problems.join("\n  ")}`);
  const v: RunnerVerdict = parsed.verdict;
  const dir = path.dirname(path.resolve(file));
  const jobs = [];
  for (const j of v.jobs) {
    const logFile = j.log ? path.join(dir, j.log) : null;
    const has = !!logFile && fs.existsSync(logFile);
    if (logFile && !has) log(`${j.name}: no log at ${j.log}; recording the job without one`);
    const { log: _l, ...rest } = j;
    jobs.push({ ...rest, ...(has ? { log_storage_id: await uploadLog(deps, logFile!) } : {}) });
  }
  return apiPost(deps, "/cli/ci/record", {
    repository: v.repository, sha: v.sha, name: v.name, run_kind: v.kind, host: v.host, run_id: v.run_id,
    started_at: v.started_at, status: v.status, ...(v.conclusion ? { conclusion: v.conclusion } : {}), jobs,
  }, { exitOnError: false, retries: 2 });
}

const MARK: Record<string, string> = { success: "ok  ", failure: "FAIL", skipped: "skip", infra: "INFR" };

/** A commit's CI as lines: each runner verdict with its jobs and failing tests, then every other run in one line each. */
export function showLines(r: any): string[] {
  if (!r.sha) return [`No CI recorded on that commit in ${r.repository}.`];
  const out = [`${r.repository} ${r.sha}`];
  for (const run of r.runs.filter((x: any) => x.kind === "runner")) {
    out.push("", `${run.name} (${run.run_kind ?? "main"} run on ${run.host ?? "?"}, run ${run.run_id ?? "?"}): ${run.status === "completed" ? run.conclusion : run.status}`);
    for (const j of run.jobs) {
      out.push(`  ${MARK[j.conclusion] ?? j.conclusion.padEnd(4)} ${j.name}${j.counts ? "" : " (does not count)"}  ${j.seconds}s${j.has_log ? "" : "  no log"}${j.note ? `  ${j.note}` : ""}`);
      for (const f of j.failing) out.push(`       ${f.file ?? "?"}${f.line ? `:${f.line}` : ""}  ${f.test ?? ""}${f.assertion ? `: ${f.assertion}` : ""}`);
    }
  }
  const others = r.runs.filter((x: any) => x.kind !== "runner");
  if (others.length) {
    out.push("", "Other CI on this commit:");
    for (const o of others) out.push(`  ${o.name} (${o.kind}): ${o.status === "completed" ? o.conclusion : o.status}${o.url ? `  ${o.url}` : ""}`);
  }
  return out;
}

export function registerCiCommand(program: Command, deps: PublishDeps): void {
  const ci = program.command("ci").description(commandGroup("ci").description);
  const fail = (err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); };

  ci.command("record")
    .description("Store a runner's verdict.json and upload the job logs beside it")
    .requiredOption("--file <path>", "The run's verdict.json (logs are read relative to it)")
    .option("--json", "Machine-readable output")
    .action(async (opts) => {
      try {
        const r = await recordVerdict(deps, opts.file, opts.json ? () => {} : console.log);
        if (opts.json) return console.log(JSON.stringify(r));
        console.log(r.written ? `Recorded ${r.sha.slice(0, 12)}: ${r.status === "completed" ? r.conclusion : r.status}` : `Not recorded: the stored run ${r.run_id} on ${r.sha.slice(0, 12)} (${r.status === "completed" ? r.conclusion : r.status}) stands, since this one is older or the same run still in progress`);
      } catch (err) { fail(err); }
    });

  ci.command("show")
    .description("A commit's CI: the runner's jobs and failing tests, and every other run on it")
    .argument("<sha>", "The commit (7 or more hex characters)")
    .option("--repo <owner/name>", "Repository (default: this checkout's origin)")
    .option("--json", "Machine-readable output")
    .action(async (sha, opts) => {
      try {
        const r = await apiPost(deps, "/cli/ci/show", { repository: repositoryOf(opts.repo), sha }, { read: true, exitOnError: false });
        console.log(opts.json ? JSON.stringify(r, null, 2) : showLines(r).join("\n"));
      } catch (err) { fail(err); }
    });

  ci.command("log")
    .description("Print a runner job's log (the tail codecast kept)")
    .argument("<sha>", "The commit")
    .argument("<job>", "The job name (test, deploy-scripts, ...)")
    .option("--repo <owner/name>", "Repository (default: this checkout's origin)")
    .action(async (sha, job, opts) => {
      try {
        const r = await apiPost(deps, "/cli/ci/log", { repository: repositoryOf(opts.repo), sha, job }, { read: true, exitOnError: false });
        if (!r.url) throw new Error(`The runner recorded no log for ${job} on ${r.sha.slice(0, 12)}.`);
        const res = await fetch(r.url, { signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`log download failed: HTTP ${res.status}`);
        process.stdout.write(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
      } catch (err) { fail(err); }
    });
}
