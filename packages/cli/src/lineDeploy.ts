// The line's deploy stage (docs/architecture/deploys.md DP2). Not per
// problem: it sends the project's shipped fixes that no live deploy has
// carried yet, together, through the team's own deploy path
// (`[line.deploy] command` in .codecast/line.toml), and records them on one
// deploy object (dp-N). `cast line deploy` shows what waits and, with --go,
// asks for the deploy and runs it here; `cast line deploy run dp-N` runs a
// deploy the Line page or the line's role asked for (the daemon's
// line_deploy command). Either way the deploy's steps run as the stations
// of the shipped line-deploy graph (DP8): `cast line deploy step` runs one,
// and a failed one comes back to the line through `cast line deploy return`.

import { spawn, spawnSync } from "./proc.js";
import { deployStepCommand, LINE_DEPLOY_GRAPH, LINE_DEPLOY_STEP_LABELS, LINE_DEPLOY_STEPS, type LineDeployProfile, type LineDeployStep } from "@codecast/shared/contracts/lineDeploy";
import { resolveCastInvocation } from "./castInvocation.js";

export type DeployStageReply = {
  project: { _id: string; short_id: string | null; title: string | null };
  deploy: { command: string | null; target: string | null; trigger: string } | null;
  device_id: string | null;
  root: string | null;
  waiting: Array<{ run_id: string; task_id: string; task_short_id: string | null; task_title: string | null; sha: string; branch: string; at: number; pr_url?: string }>;
  open: { short_id: string; status: string; target: string; created_at: number; steps?: Array<{ id: string; status: string }> } | null;
  /** The role trigger (DP4): the role, whether it may deploy now, why not, today's count. */
  auto?: { role: string; allowed: boolean; reason: string | null; used: number; limit: number | null } | null;
};

export type Post = (path: string, body: Record<string, unknown>) => Promise<any>;

/**
 * Model and cloud keys never reach the deploy path: a deploy script has no
 * use for them, and a shell that holds another product's prod key (Union's
 * OpenRouter key) must not hand it to a child.
 */
const SCRUBBED_ENV = /^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|GOOGLE_GENERATIVE_AI|FAL|REPLICATE|XAI|GROQ|MISTRAL|DEEPSEEK|COHERE|PERPLEXITY|ELEVENLABS|AWS)_[A-Z0-9_]*$|^FAL_KEY$/;

export function deployEnv(base: NodeJS.ProcessEnv, vars: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!SCRUBBED_ENV.test(k)) env[k] = v;
  for (const [k, v] of Object.entries(vars)) env[`CAST_DEPLOY_${k.toUpperCase()}`] = v;
  return env;
}

/** `$sha`, `$deploy` and `$actor` in the profile's command, quoted for the shell. */
export function expandDeployCommand(command: string, vars: { sha: string; deploy: string; actor: string }): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return command.replace(/\$(sha|deploy|actor)\b/g, (_, k: keyof typeof vars) => q(vars[k]));
}

/** The default branch's head on origin, after a fetch: what a deploy of main puts out. */
export function originHead(root: string): { sha: string | null; branch: string } {
  const head = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: root, encoding: "utf-8" });
  const branch = head.status === 0 ? String(head.stdout).trim().replace(/^origin\//, "") : "main";
  spawnSync("git", ["fetch", "--quiet", "origin", branch], { cwd: root, encoding: "utf-8", timeout: 60_000 });
  const sha = spawnSync("git", ["rev-parse", `origin/${branch}`], { cwd: root, encoding: "utf-8" });
  return { sha: sha.status === 0 ? String(sha.stdout).trim() : null, branch };
}

/** The stage in words, for `cast line deploy`. */
export function formatStage(s: DeployStageReply): string {
  const out: string[] = [];
  const name = s.project.title ?? s.project.short_id ?? s.project._id;
  if (!s.deploy?.command) out.push(`${name}: no deploy stage. Add [line.deploy] command to .codecast/line.toml and publish it (cast line profile --publish).`);
  else out.push(`${name}: deploys to ${s.deploy.target ?? "(no target named)"} with: ${s.deploy.command}`);
  if (s.auto) out.push(`@${s.auto.role} sends what waits${s.auto.limit !== null ? ` (${s.auto.used} of ${s.auto.limit} today)` : ""}${s.auto.allowed ? "." : `, but waits: ${s.auto.reason}.`}`);
  if (s.open) out.push(`${s.open.short_id} is ${s.open.status === "requested" ? "waiting for its machine" : "going out"} to ${s.open.target}.${s.open.steps?.length ? ` ${formatSteps(s.open.steps)}` : ""}`);
  if (!s.waiting.length) out.push("Nothing is waiting to go out: every shipped fix is live.");
  else {
    out.push(`${s.waiting.length} shipped fix${s.waiting.length === 1 ? "" : "es"} waiting to go out:`);
    for (const w of s.waiting) out.push(`  ${w.task_short_id ?? w.task_id}  ${w.sha.slice(0, 10)}  ${w.task_title ?? ""}`);
    if (s.deploy?.command && !s.open) out.push("", "Send them: cast line deploy --go");
  }
  return out.join("\n");
}

/** A deploy's steps as its run's stations stand (DP8): `CI done · Send done · Gate failed`. */
export function formatSteps(steps: Array<{ id: string; status: string }>): string {
  const word: Record<string, string> = { completed: "done", running: "running", failed: "failed", pending: "waiting" };
  return steps.map((s) => `${s.id === "returned" ? "Back to the line" : LINE_DEPLOY_STEP_LABELS[s.id as LineDeployStep] ?? s.id} ${word[s.status] ?? s.status}`).join(" · ");
}

/** One deploy in words, for `cast line deploy show`. */
export function formatDeploy(d: any): string {
  const when = (t: number | null) => (t ? new Date(t).toLocaleString() : "-");
  const out = [
    `${d.short_id}  ${d.target}${d.sha ? ` ${String(d.sha).slice(0, 10)}` : ""}  ${d.status}`,
    `went live ${when(d.live_at)} · started by ${d.started_by?.name ?? d.source} (${d.trigger}) · reported by ${d.source}${d.url ? ` · ${d.url}` : ""}`,
  ];
  if (d.steps?.length) out.push(formatSteps(d.steps));
  out.push("", `carried ${d.carries.length}`);
  for (const c of d.carries) {
    const p = d.after?.problems?.find((x: any) => x.task_id === c.task_id);
    out.push(`  ${c.task_short_id ?? c.task_id}  ${c.how}${c.decision_short_id ? ` · ${c.decision_short_id}` : ""}${p ? ` · ${p.findings} after${p.reopened ? ", reopened" : ""}` : ""}  ${c.task_title ?? ""}`);
  }
  if (d.after?.errors?.length) {
    out.push("", `errors in its window ${d.after.errors.length}`);
    for (const e of d.after.errors) out.push(`  ${e.kind === "new" ? "new " : "back"}  ${e.short_id}  ${e.title}`);
  }
  if (d.commits?.length) out.push("", `commits ${d.commits.length}`, ...d.commits.slice(0, 20).map((c: any) => `  ${String(c.sha).slice(0, 7)}  ${c.subject}`));
  return out.join("\n");
}

/**
 * Run a deploy's steps (deploys.md DP8): the shipped line-deploy graph, as a
 * workflow run of its own in the checkout, so the runner keeps each
 * station's state, timeout and resume. Returns the run's exit code.
 */
export function runDeployGraph(deploy: string, root: string): number {
  const { cmd, prefixArgs } = resolveCastInvocation();
  const ran = spawnSync(cmd, [...prefixArgs, "workflow", "run", LINE_DEPLOY_GRAPH, "--goal", deploy], { cwd: root, stdio: "inherit", env: { ...process.env, CODECAST_CWD: root } });
  return ran.status ?? 1;
}

function shellExec(command: string, env: NodeJS.ProcessEnv, cwd: string, onData: (chunk: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b) => onData(String(b)));
    child.stderr.on("data", (b) => onData(String(b)));
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) => { onData(`${err.message}\n`); resolve(1); });
  });
}

// ── a deploy's steps as stations (deploys.md DP8, DP9) ───────────────────────

export type DeployRead = (ref: string) => Promise<any>;

/**
 * One step of a deploy, run by its station in the line-deploy graph. The
 * first step fixes the deploy's sha (the default branch's head on origin)
 * and names the run on the deploy; every step after reads that sha back, so
 * all of them judge the same commit. A step the profile leaves out passes
 * with a note. The send step's output names the deploy path's run (a GitHub
 * Actions url), which the gate and rollout steps follow.
 */
export async function runDeployStep(opts: {
  step: LineDeployStep;
  deploy: string;
  root: string;
  profile: Partial<LineDeployProfile> | null | undefined;
  runId?: string;
  read: DeployRead;
  post: Post;
  log?: (line: string) => void;
  exec?: (cmd: string, env: NodeJS.ProcessEnv, cwd: string, onData: (chunk: string) => void) => Promise<number>;
  head?: (root: string) => { sha: string | null; branch: string };
}): Promise<{ code: number; note: string | null }> {
  const log = opts.log ?? ((l) => process.stdout.write(l));
  const d = await opts.read(opts.deploy);
  if (!d) return { code: 1, note: `No deploy ${opts.deploy} you can read` };
  if (d.status === "live" || d.status === "cancelled") {
    log(`${opts.deploy} is already ${d.status}; ${LINE_DEPLOY_STEP_LABELS[opts.step]} has nothing to do\n`);
    return { code: 0, note: null };
  }
  let sha: string | null = d.sha ?? null;
  if (!sha) sha = (opts.head ?? originHead)(opts.root).sha;
  if (!sha) return { code: 1, note: "Could not read the default branch's head on origin" };
  // Running, with the sha and the run, said once; a report never moves a deploy backwards.
  if (d.status === "requested" || !d.sha || (opts.runId && !d.run_id)) {
    await opts.post("/cli/line/deploy/report", { deploy: opts.deploy, status: "running", sha, ...(opts.runId ? { run_id: opts.runId } : {}) });
  }
  const command = deployStepCommand(opts.profile, opts.step);
  if (!command) {
    const note = `No ${opts.step === "send" ? "command" : opts.step} in [line.deploy]: ${LINE_DEPLOY_STEP_LABELS[opts.step]} passes.`;
    log(`${note}\n`);
    return { code: 0, note };
  }
  const actor = d.started_by?.name ?? "cast";
  let tail = "";
  const onData = (chunk: string) => { log(chunk); tail = (tail + chunk).slice(-4000); };
  const env = deployEnv(process.env, { sha, id: opts.deploy, actor, ...(d.url ? { url: d.url } : {}) });
  const code = await (opts.exec ?? shellExec)(expandDeployCommand(command, { sha, deploy: opts.deploy, actor }), env, opts.root, onData);
  // The path's run page, named on the deploy so the steps after can follow it.
  const url = tail.match(/https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+/)?.[0];
  if (url && url !== d.url) await opts.post("/cli/line/deploy/report", { deploy: opts.deploy, status: "running", url });
  return { code, note: code === 0 ? null : `exited ${code}\n${tail.slice(-1500)}` };
}

/** The watch station: the deploy is live, and its shipped fixes are watched from now (LE12). */
export async function watchDeploy(opts: { deploy: string; watchDays: number; read: DeployRead; post: Post }): Promise<string> {
  const d = await opts.read(opts.deploy);
  if (!d) throw new Error(`No deploy ${opts.deploy} you can read`);
  await opts.post("/cli/line/deploy/report", { deploy: opts.deploy, status: "live", ...(d.sha ? { sha: d.sha } : {}), watch_days: opts.watchDays });
  return `${opts.deploy} is live${d.sha ? ` at ${String(d.sha).slice(0, 10)}` : ""}; ${(n => `${n} fix${n === 1 ? " is" : "es are"}`)(d.carries?.length ?? 0)} watched for ${opts.watchDays} days from now`;
}

/** The station that failed in a deploy run: the last failed step before Returned. */
export function failedStep(nodeStatuses: Array<{ node_id: string; status: string }> | null | undefined): LineDeployStep | null {
  const steps = new Set<string>(LINE_DEPLOY_STEPS);
  const failed = (nodeStatuses ?? []).filter((n) => n.status === "failed" && steps.has(n.node_id));
  return (failed[failed.length - 1]?.node_id as LineDeployStep) ?? null;
}

/** The finding a failed step files (DP9): one problem per project, target and step, whatever the deploy. */
export function deployFailureSignal(d: any, step: LineDeployStep | null, note: string | null): Record<string, unknown> {
  const label = step ? LINE_DEPLOY_STEP_LABELS[step] : "a step";
  const project = d.project_id ?? "workspace";
  const carried = (d.carries ?? []).map((c: any) => `- ${c.task_short_id ?? c.task_id} ${c.task_title ?? ""}`.trimEnd());
  return {
    source: "deploy",
    kind: "regression",
    fingerprint: `deploy:${project}:${d.target}:${step ?? "step"}`,
    issue: true,
    title: `Deploy to ${d.target} stopped at ${label}`,
    detail_md: [
      `${d.short_id}${d.sha ? ` at ${String(d.sha).slice(0, 10)}` : ""} stopped at ${label}, so its fixes did not go live and wait for the next deploy.`,
      ...(d.url ? [`Run: ${d.url}`] : []),
      ...(carried.length ? ["", "It carried:", ...carried] : []),
      ...(note ? ["", "What the step said:", "```", note.trim().slice(-1500), "```"] : []),
    ].join("\n"),
    ...(d.url ? { evidence_url: d.url } : {}),
    subject: `deploy:${d.target}:${step ?? "step"}`,
    ...(d.project_id ? { project: d.project_id } : {}),
  };
}

/** The Returned station: the deploy failed at a step, and that failure comes back to the line as work. */
export async function returnDeploy(opts: { deploy: string; runId?: string; note?: string; scope?: Record<string, unknown>; read: DeployRead; readRun: (id: string) => Promise<any>; post: Post }): Promise<{ step: LineDeployStep | null; signal: any }> {
  const d = await opts.read(opts.deploy);
  if (!d) throw new Error(`No deploy ${opts.deploy} you can read`);
  const run = opts.runId ? await opts.readRun(opts.runId).catch(() => null) : null;
  const step = failedStep(run?.run?.node_statuses ?? run?.node_statuses);
  const note = opts.note?.trim() || null;
  const label = step ? LINE_DEPLOY_STEP_LABELS[step] : "a step";
  await opts.post("/cli/line/deploy/report", { deploy: opts.deploy, status: "failed", note: `Stopped at ${label}.${note ? `\n${note.slice(-1500)}` : ""}` });
  const signal = await opts.post("/cli/signal/add", { ...deployFailureSignal(d, step, note), ...(opts.scope ?? {}) });
  return { step, signal };
}

/** The deploy path's GitHub Actions run named in a url: its repository and id. */
export function actionsRunOf(url: string | null | undefined): { repo: string; id: string } | null {
  const m = (url ?? "").match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)/);
  return m ? { repo: m[1], id: m[2] } : null;
}

const JOB_PASSED = new Set(["success", "neutral"]);

export type GhJob = { name: string; status: string; conclusion: string | null; databaseId?: number; url?: string };

/** Where the named jobs of a run stand: all passed, one failed, or still going. A skipped or cancelled job fails: the step it stands for did not happen. */
export function jobsVerdict(jobs: GhJob[], names: string[], runDone: boolean): { state: "passed" | "failed" | "waiting"; detail: string } {
  const picked = names.map((n) => ({ name: n, job: jobs.find((j) => j.name === n || j.name.startsWith(`${n} `) || j.name.startsWith(`${n} /`)) }));
  const failed = picked.find((p) => p.job && p.job.status === "completed" && !JOB_PASSED.has(p.job.conclusion ?? ""));
  if (failed) return { state: "failed", detail: `${failed.name} ended ${failed.job!.conclusion}${failed.job!.url ? ` (${failed.job!.url})` : ""}` };
  const missing = picked.filter((p) => !p.job);
  if (missing.length && runDone) return { state: "failed", detail: `the run finished with no job named ${missing.map((p) => p.name).join(", ")}` };
  if (missing.length || picked.some((p) => p.job!.status !== "completed")) return { state: "waiting", detail: picked.map((p) => `${p.name}: ${p.job ? p.job.conclusion ?? p.job.status : "not started"}`).join(", ") };
  return { state: "passed", detail: picked.map((p) => `${p.name}: ${p.job!.conclusion}`).join(", ") };
}

/**
 * `cast line deploy follow --jobs a,b`: wait for jobs of the deploy path's
 * run (CAST_DEPLOY_URL, set by the step) and exit 0 when they pass, 1 when
 * one fails, with its failed log's tail. For a deploy path that runs its
 * own gate and rollout as jobs of one run (Union's deploy.yml), this is how
 * those jobs become the line's gate and rollout stations.
 */
export async function followJobs(opts: {
  url: string | null | undefined;
  jobs: string[];
  gh?: (args: string[]) => { code: number; out: string };
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  pollMs?: number;
  maxPolls?: number;
}): Promise<number> {
  const log = opts.log ?? ((l) => console.log(l));
  const run = actionsRunOf(opts.url);
  if (!run) { log("No GitHub Actions run is named on this deploy: the send step prints its url, or this path has no run to follow"); return 1; }
  const gh = opts.gh ?? ghCli;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last = "";
  for (let i = 0; i < (opts.maxPolls ?? Number.POSITIVE_INFINITY); i++) {
    const r = gh(["run", "view", run.id, "--repo", run.repo, "--json", "status,conclusion,jobs"]);
    if (r.code === 0) {
      const view = JSON.parse(r.out);
      const v = jobsVerdict(view.jobs ?? [], opts.jobs, view.status === "completed");
      if (v.detail !== last) { log(v.detail); last = v.detail; }
      if (v.state === "passed") return 0;
      if (v.state === "failed") {
        const job = (view.jobs ?? []).find((j: GhJob) => j.status === "completed" && opts.jobs.some((n) => j.name === n || j.name.startsWith(`${n} `)) && !JOB_PASSED.has(j.conclusion ?? ""));
        if (job?.databaseId) {
          const logs = gh(["run", "view", run.id, "--repo", run.repo, "--log-failed", "--job", String(job.databaseId)]);
          if (logs.code === 0) log(logs.out.split("\n").slice(-40).join("\n"));
        }
        return 1;
      }
    } else if (i === 0) log(`gh run view ${run.id} failed: ${r.out.trim().slice(0, 300)}`);
    await sleep(opts.pollMs ?? 20_000);
  }
  log(`still waiting: ${last}`);
  return 1;
}

/**
 * `cast line deploy ci`: wait for CI's verdict on the deploy sha
 * (CAST_DEPLOY_SHA): the newest finished run of the named workflow on that
 * commit, or with no workflow named, every check run on it. Green exits 0;
 * red exits 1 with its url; no verdict within the wait exits 1.
 */
export async function waitForCi(opts: {
  sha: string;
  workflow?: string;
  repo?: string;
  gh?: (args: string[]) => { code: number; out: string };
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  pollMs?: number;
  maxPolls?: number;
}): Promise<number> {
  const log = opts.log ?? ((l) => console.log(l));
  const gh = opts.gh ?? ghCli;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const repo = opts.repo ?? gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).out.trim();
  if (!repo) { log("Could not tell which GitHub repository this checkout is"); return 1; }
  let last = "";
  const polls = opts.maxPolls ?? 120;
  for (let i = 0; i < polls; i++) {
    const verdict = opts.workflow ? workflowVerdict(gh, repo, opts.workflow, opts.sha) : checksVerdict(gh, repo, opts.sha);
    if (verdict.detail !== last) { log(verdict.detail); last = verdict.detail; }
    if (verdict.state === "passed") return 0;
    if (verdict.state === "failed") return 1;
    await sleep(opts.pollMs ?? 30_000);
  }
  log(`CI reached no verdict on ${opts.sha.slice(0, 10)}: ${last}`);
  return 1;
}

function workflowVerdict(gh: (a: string[]) => { code: number; out: string }, repo: string, workflow: string, sha: string): { state: "passed" | "failed" | "waiting"; detail: string } {
  const r = gh(["run", "list", "--repo", repo, "--workflow", workflow, "--commit", sha, "--limit", "20", "--json", "status,conclusion,url,startedAt,attempt"]);
  if (r.code !== 0) return { state: "waiting", detail: `gh run list failed: ${r.out.trim().slice(0, 200)}` };
  const runs: Array<{ status: string; conclusion: string | null; url: string; startedAt: string; attempt?: number }> = JSON.parse(r.out || "[]");
  // A rerun in flight is the run's newest attempt: an older green attempt does not outrank it.
  if (runs.some((x) => x.status !== "completed" && (x.attempt ?? 1) > 1)) return { state: "waiting", detail: `${workflow} on ${sha.slice(0, 10)} is being re-run` };
  const done = runs.filter((x) => x.status === "completed").sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const newest = done[done.length - 1];
  if (newest?.conclusion === "success") return { state: "passed", detail: `${workflow} is green on ${sha.slice(0, 10)}: ${newest.url}` };
  if (newest && !runs.some((x) => x.status !== "completed")) return { state: "failed", detail: `${workflow} ended ${newest.conclusion} on ${sha.slice(0, 10)}: ${newest.url}` };
  return { state: "waiting", detail: `${workflow} has no verdict on ${sha.slice(0, 10)} yet` };
}

function checksVerdict(gh: (a: string[]) => { code: number; out: string }, repo: string, sha: string): { state: "passed" | "failed" | "waiting"; detail: string } {
  const r = gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {name, status, conclusion, html_url}]"]);
  if (r.code !== 0) return { state: "waiting", detail: `gh api failed: ${r.out.trim().slice(0, 200)}` };
  const checks: Array<{ name: string; status: string; conclusion: string | null; html_url: string }> = JSON.parse(r.out || "[]");
  if (!checks.length) return { state: "waiting", detail: `no checks on ${sha.slice(0, 10)} yet` };
  const red = checks.find((x) => x.status === "completed" && !["success", "skipped", "neutral"].includes(x.conclusion ?? ""));
  if (red) return { state: "failed", detail: `${red.name} ended ${red.conclusion} on ${sha.slice(0, 10)}: ${red.html_url}` };
  const going = checks.filter((x) => x.status !== "completed");
  if (going.length) return { state: "waiting", detail: `${going.length} of ${checks.length} checks still running on ${sha.slice(0, 10)}` };
  return { state: "passed", detail: `${checks.length} checks green on ${sha.slice(0, 10)}` };
}

function ghCli(args: string[]): { code: number; out: string } {
  const r = spawnSync("gh", args, { encoding: "utf-8", timeout: 60_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.status === 0 ? "" : r.stderr ?? ""}` };
}
