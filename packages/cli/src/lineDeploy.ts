// The line's deploy stage (docs/architecture/deploys.md DP2). Not per
// problem: it sends the project's shipped fixes that no live deploy has
// carried yet, together, through the team's own deploy path
// (`[line.deploy] command` in .codecast/line.toml), and records them on one
// deploy object (dp-N). `cast line deploy` shows what waits and, with --go,
// asks for the deploy and runs it here; `cast line deploy run dp-N` runs a
// deploy the Line page asked for (the daemon's line_deploy command).

import { spawn, spawnSync } from "./proc.js";

export type DeployStageReply = {
  project: { _id: string; short_id: string | null; title: string | null };
  deploy: { command: string | null; target: string | null; trigger: string } | null;
  device_id: string | null;
  root: string | null;
  waiting: Array<{ run_id: string; task_id: string; task_short_id: string | null; task_title: string | null; sha: string; branch: string; at: number; pr_url?: string }>;
  open: { short_id: string; status: string; target: string; created_at: number } | null;
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
  if (s.open) out.push(`${s.open.short_id} is ${s.open.status === "requested" ? "waiting for its machine" : "going out"} to ${s.open.target}.`);
  if (!s.waiting.length) out.push("Nothing is waiting to go out: every shipped fix is live.");
  else {
    out.push(`${s.waiting.length} shipped fix${s.waiting.length === 1 ? "" : "es"} waiting to go out:`);
    for (const w of s.waiting) out.push(`  ${w.task_short_id ?? w.task_id}  ${w.sha.slice(0, 10)}  ${w.task_title ?? ""}`);
    if (s.deploy?.command && !s.open) out.push("", "Send them: cast line deploy --go");
  }
  return out.join("\n");
}

/** One deploy in words, for `cast line deploy show`. */
export function formatDeploy(d: any): string {
  const when = (t: number | null) => (t ? new Date(t).toLocaleString() : "-");
  const out = [
    `${d.short_id}  ${d.target}${d.sha ? ` ${String(d.sha).slice(0, 10)}` : ""}  ${d.status}`,
    `went live ${when(d.live_at)} · started by ${d.started_by?.name ?? d.source} (${d.trigger}) · reported by ${d.source}${d.url ? ` · ${d.url}` : ""}`,
  ];
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

export type RunDeployResult = { status: "live" | "failed"; code: number; sha: string | null; tail: string };

/**
 * Run the deploy path for a deploy that was asked for: report it running,
 * run the command from the checkout's root with its output streamed, then
 * report live (with the sha it put out) or failed (with the output's tail).
 * A deploy marker from the path itself may finish the deploy first; the
 * server never moves a deploy backwards.
 */
export async function runDeploy(opts: {
  root: string;
  deploy: string;
  command: string;
  actor: string;
  post: Post;
  log?: (line: string) => void;
  exec?: (cmd: string, env: NodeJS.ProcessEnv, cwd: string, onData: (chunk: string) => void) => Promise<number>;
}): Promise<RunDeployResult> {
  const log = opts.log ?? ((l) => process.stdout.write(l));
  const { sha } = originHead(opts.root);
  const command = expandDeployCommand(opts.command, { sha: sha ?? "", deploy: opts.deploy, actor: opts.actor });
  await opts.post("/cli/line/deploy/report", { deploy: opts.deploy, status: "running", ...(sha ? { sha } : {}) });
  let tail = "";
  const onData = (chunk: string) => {
    log(chunk);
    tail = (tail + chunk).slice(-4000);
  };
  const env = deployEnv(process.env, { sha: sha ?? "", id: opts.deploy, actor: opts.actor });
  const code = await (opts.exec ?? shellExec)(command, env, opts.root, onData);
  const status = code === 0 ? "live" : "failed";
  // A deploy path that prints its run's page names it on the deploy (a GitHub Actions run).
  const url = tail.match(/https:\/\/github\.com\/[^\s]+\/actions\/runs\/\d+/)?.[0];
  await opts.post("/cli/line/deploy/report", {
    deploy: opts.deploy,
    status,
    ...(sha ? { sha } : {}),
    ...(url ? { url } : {}),
    ...(code === 0 ? {} : { note: `exited ${code}\n${tail.slice(-1500)}` }),
  });
  return { status, code, sha, tail };
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
