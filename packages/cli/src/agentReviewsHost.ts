// The machine half of agent reviews (convex agentReviews.ts): this machine
// runs up to N reviews at once, each a Claude Code session in the dry-run
// harness's isolation (scripts/prompt-dry-run.ts: a private config dir, so the
// session lands in nobody's inbox; the read-only sandbox; the guard in place
// of `cast`), on the saved subscription profiles that have room.
//
// A person turns it on with `cast line reviews run --slots N` (written to
// agent-reviews.json beside the CLI's state), and the daemon's pass does the
// rest every 30 seconds: hand back what finished, renew the leases of what
// runs, stop what ran past its deadline or was taken back, and claim as many
// queued reviews as there are free slots and accounts.
//
// Each review runs:
//  - in a checkout of the product's repo at its default branch, a detached
//    worktree of the judge's repo per commit, so a review never reads another
//    session's uncommitted work and a refresh never moves files under one;
//  - beside the judge's gateway, a loopback server started once from the
//    judge's repo that reads the product's data read-only and holds its key,
//    so the session never sees a key (every .env under home is unreadable to
//    it, and every key-like variable is stripped from its environment);
//  - with both turns given to the harness, the review and then the findings.
// A run's directory holds what the harness wrote; it is handed back as the
// transcript and the findings, and removed once the server has it. A daemon
// that restarts finds the directories again: a finished run is handed back, a
// live one is watched, a dead one is handed back as failed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { TOOL_PATH, execFileAsync, findOnPath, spawn } from "./proc.js";
import { codecastPath } from "./codecastDir.js";
import { bunPath } from "./momentsHost.js";
import { execFileToFile } from "./worktreeLegacy.js";
import { accountTokenFilePath, readActiveCredentialAsync } from "./ccAccounts.js";
import { loadLocalUsageProfiles, type UsageProfile } from "./usageCommand.js";
import { isUsageExhausted, livePercent, worstUsagePercent } from "@codecast/shared/contracts";
import { transcriptFromStream, type ReviewTranscript } from "@codecast/shared/contracts/agentJudges";

/** What `cast line reviews run` sets on this machine. */
export type ReviewsConfig = {
  /** Reviews at once; 0 is off. */
  slots: number;
  /** Saved profiles reviews may run on; every profile with a setup token when absent. */
  accounts?: string[];
  /** A profile whose week is at or above this share takes no new review: the headroom it keeps is the account's. */
  max_percent: number;
  /** A profile whose 5-hour window is at or above this share takes no new review, so those already running finish before its limit. */
  session_max_percent?: number;
  /** Reviews one profile runs at once. */
  per_account: number;
  /** Where the judge's repo sits on this machine, by source, when not where it was published. */
  roots?: Record<string, string>;
  /** While the machine's CPU is idle less than busy_idle_percent of the time, no more than this many run. */
  slots_when_busy?: number;
  busy_idle_percent?: number;
};

export const REVIEWS_DEFAULTS: ReviewsConfig = { slots: 0, max_percent: 85, session_max_percent: 95, per_account: 3, busy_idle_percent: 15 };

/** CPU idle share since the previous reading, from the kernel's per-core counters; null on the first reading. */
let cpuBefore: { idle: number; total: number } | null = null;
export function cpuIdleShare(): number | null {
  const now = os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.idle + c.times.user + c.times.sys + c.times.nice + c.times.irq }), { idle: 0, total: 0 });
  const before = cpuBefore;
  cpuBefore = now;
  if (!before || now.total <= before.total) return null;
  return (now.idle - before.idle) / (now.total - before.total);
}

/** The slots a pass fills: the configured ones, or fewer while the machine is busy (other work shares its CPU, and a starved review only runs longer). */
export function slotsNow(cfg: ReviewsConfig, idle: number | null): number {
  if (cfg.slots_when_busy == null || idle == null) return cfg.slots;
  return idle * 100 < (cfg.busy_idle_percent ?? 15) ? Math.min(cfg.slots, cfg.slots_when_busy) : cfg.slots;
}
export const REVIEWS_TICK_MS = 30_000;
const REVIEW_NICE = 10;

export const reviewsConfigFile = () => codecastPath("agent-reviews.json");
export const reviewsDir = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "codecast", "agent-reviews");
const runsDir = () => path.join(reviewsDir(), "runs");
const checkoutsDir = () => path.join(reviewsDir(), "checkouts");

export function readReviewsConfig(): ReviewsConfig {
  try {
    return { ...REVIEWS_DEFAULTS, ...JSON.parse(fs.readFileSync(reviewsConfigFile(), "utf8")) };
  } catch {
    return { ...REVIEWS_DEFAULTS };
  }
}

export function writeReviewsConfig(patch: Partial<ReviewsConfig>): ReviewsConfig {
  const next = { ...readReviewsConfig(), ...patch };
  fs.mkdirSync(path.dirname(reviewsConfigFile()), { recursive: true });
  fs.writeFileSync(reviewsConfigFile(), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** A claimed review as the server hands it (agentReviews.ReviewClaim). */
export type ReviewClaim = {
  review: string;
  moment: string;
  subject: string;
  source: string;
  judge: { name: string; version: string; model: string; root: string; agent: { tools: string[]; cwd: string; max_turns: number; timeout_ms: number; claude_md?: string; gateway?: string } };
  turns: [string, string];
  deadline: number;
};

// ── The session's environment ──

/** Variables a review session never inherits: anything that names a key, token, secret or credential, every route to a model off the subscription, and the launching session's identity. */
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;
const MODEL_ROUTE = /^(?:ANTHROPIC_|OPENROUTER_|OPENAI_|GEMINI_|GOOGLE_|AWS_|FAL_|REPLICATE_|AZURE_|CLAUDE_CODE_USE_|VERTEX_)/;
const IDENTITY = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODECAST_LAUNCH_TOKEN", "CODECAST_SESSION_ID", "TMUX", "TMUX_PANE", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "DATABASE_URL", "READONLY_DATABASE_URL"]);

export function reviewEnv(base: NodeJS.ProcessEnv = process.env, add: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || IDENTITY.has(k) || SECRET_NAME.test(k) || MODEL_ROUTE.test(k) || /_URL$/.test(k) && /DATABASE|POSTGRES|REDIS/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...add };
}

// ── Accounts ──

/**
 * The saved profiles a new review may start on now, best first: each has a
 * setup token (the harness signs in with it), is not the one this machine's
 * sessions run on (whichever that is now), is allowed by the config, is
 * under its share and under its own cap of running reviews, and has not hit a
 * limit lately. Fewest running first, then most room.
 */
export function pickAccounts(cfg: ReviewsConfig, running: Map<string, number>, cooling: Map<string, number>, now = Date.now()): string[] {
  return rankAccounts(tokenProfiles(), cfg, running, cooling, now);
}

/** The saved profiles with a setup token; `credential` is the active login when already read. */
const tokenProfiles = (credential?: string | null) =>
  loadLocalUsageProfiles(credential).filter((p) => fs.existsSync(accountTokenFilePath(p.name)));

/** pickAccounts over profiles already read, those with a setup token. */
export function rankAccounts(profiles: Pick<UsageProfile, "name" | "active" | "usage">[], cfg: ReviewsConfig, running: Map<string, number>, cooling: Map<string, number>, now: number): string[] {
  const allowed = cfg.accounts?.length ? new Set(cfg.accounts) : null;
  return profiles
    // The profile this machine's sessions run on is left to them, even when the config names it.
    .filter((p) => !p.active && (!allowed || allowed.has(p.name)))
    .filter((p) => (cooling.get(p.name) ?? 0) <= now && !isUsageExhausted(p.usage, now))
    // Each window as it stands now: one rolled since the last probe counts as empty, the others keep their measured share,
    // so a week at its stop still stops the account when its 5-hour window rolls.
    .map((p) => ({ name: p.name, week: p.usage?.weekly ? livePercent(p.usage.weekly, now) : 0, session: p.usage?.session ? livePercent(p.usage.session, now) : 0, percent: worstUsagePercent(p.usage, now), busy: running.get(p.name) ?? 0 }))
    .filter((p) => p.busy < cfg.per_account && p.week < cfg.max_percent && p.session < (cfg.session_max_percent ?? REVIEWS_DEFAULTS.session_max_percent!))
    .sort((a, b) => a.busy - b.busy || (a.percent ?? 50) - (b.percent ?? 50))
    .map((p) => p.name);
}

// ── Checkouts and gateways ──

// Off the loop: these run in the daemon, where a synchronous git under load
// blocked it for seconds at a time and starved every other timer.
const git = (cwd: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> =>
  execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout, stderr }) => ({ status: 0, stdout, stderr }),
    (err: { code?: unknown; stdout?: string; stderr?: string }) => ({ status: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err) }),
  );

let fetchedAt = new Map<string, number>();

/** A worktree of `root`'s repository at its origin's default branch as of now, made once per commit; older ones no run uses are removed. */
export async function checkoutFor(root: string, inUse: Set<string>, now = Date.now()): Promise<string> {
  if ((fetchedAt.get(root) ?? 0) < now - 30 * 60_000) {
    await git(root, ["fetch", "--quiet", "origin"]);
    fetchedAt.set(root, now);
  }
  const head = (await git(root, ["rev-parse", "origin/HEAD"])).stdout.trim() || (await git(root, ["rev-parse", "origin/main"])).stdout.trim();
  if (!head) throw new Error(`no origin default branch in ${root}`);
  const name = `${path.basename(root)}-${head.slice(0, 10)}`;
  const dir = path.join(checkoutsDir(), name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(checkoutsDir(), { recursive: true });
    // Not through git(): a post-checkout hook's background job would hold its pipes.
    await execFileToFile("git", ["-C", root, "worktree", "add", "--detach", "--quiet", dir, head]).catch((err: { stderr?: string }) => {
      throw new Error(`could not check out ${head.slice(0, 10)} of ${root}: ${(err.stderr ?? String(err)).trim().slice(0, 300)}`);
    });
  }
  for (const other of fs.readdirSync(checkoutsDir())) {
    const p = path.join(checkoutsDir(), other);
    if (other === name || !other.startsWith(`${path.basename(root)}-`) || inUse.has(p)) continue;
    await git(root, ["worktree", "remove", "--force", p]);
  }
  return dir;
}

type Gateway = { key: string; child: ReturnType<typeof spawn>; env: Record<string, string> };
const gateways = new Map<string, Gateway>();

/** The judge's gateway, started once from its repo and kept while it lives: its {"env": …} line is what every review session gets. */
export async function gatewayFor(root: string, rel: string, log: (l: string) => void): Promise<Record<string, string>> {
  const file = path.join(root, ".codecast", "judges", rel);
  const version = (await git(path.dirname(file), ["hash-object", file])).stdout.trim();
  const key = `${file}@${version}`;
  const known = gateways.get(file);
  if (known && known.key === key && known.child.exitCode === null) return known.env;
  if (known) try { known.child.kill("SIGTERM"); } catch { /* gone */ }
  if (!fs.existsSync(file)) throw new Error(`the judge's gateway ${rel} is not in ${root}/.codecast/judges`);
  // The gateway holds the product's read key itself; it gets no model key either.
  const child = spawn(bunPath(), [file], { cwd: root, env: reviewEnv(process.env, { HOME: os.homedir() }), stdio: ["ignore", "pipe", "pipe"] });
  const env = await new Promise<Record<string, string>>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the gateway ${rel} printed no {"env": …} line in 20s`)), 20_000);
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) return;
      try {
        const parsed = JSON.parse(line);
        clearTimeout(timer);
        resolve(Object.fromEntries(Object.entries(parsed?.env ?? {}).map(([k, v]) => [k, String(v)])));
      } catch { /* a partial line */ }
    });
    child.stderr!.on("data", (d: Buffer) => log(`[REVIEWS] gateway: ${d.toString("utf8").trim().slice(0, 300)}`));
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the gateway ${rel} exited ${code}`)); });
  });
  gateways.set(file, { key, child, env });
  log(`[REVIEWS] gateway ${rel} up (${Object.keys(env).join(", ")})`);
  return env;
}

/** Stop every gateway this process started: a one-shot command's, once its sessions are done. */
export function stopGateways(): void {
  for (const [file, g] of gateways) {
    try { g.child.kill("SIGTERM"); } catch { /* gone */ }
    gateways.delete(file);
  }
}

// ── One run ──

/** The directory of the real `cast` this machine runs, searched past a launchd PATH; null when there is none. */
export function realCastDir(): string | null {
  const found = findOnPath("cast", [TOOL_PATH, codecastPath("bin")].join(path.delimiter));
  return found ? path.dirname(found) : null;
}

/**
 * One runner per machine: the daemon's pass and a `cast line reviews pass`
 * share the run directories and the slots, so two at once hand back each
 * other's runs and run twice the slots. The first takes the lock for as long
 * as its process lives; another stands by.
 */
export function holdRunnerLock(pid = process.pid): number | null {
  const file = path.join(reviewsDir(), "runner.pid");
  fs.mkdirSync(reviewsDir(), { recursive: true });
  const holder = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : 0);
  if (holder && holder !== pid && pidAlive(holder)) return holder;
  fs.writeFileSync(file, `${pid}\n`);
  return null;
}

/** The dry-run harness beside this source tree; reviews need it, so a build without it runs none. */
export function harnessScript(): string | null {
  const p = path.resolve(import.meta.dir, "../scripts/prompt-dry-run.ts");
  return fs.existsSync(p) ? p : null;
}

type RunFiles = { dir: string; claim: ReviewClaim; account: string; started: number; checkout: string };

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Start one review's session in its run directory (`dir`, else the runner's own for the review); resolves once the harness is running. */
export function startRun(claim: ReviewClaim, account: string, o: { checkout: string; gatewayEnv: Record<string, string>; harness: string; castDir: string; dir?: string }): RunFiles {
  const dir = o.dir ?? path.join(runsDir(), claim.review);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const started = Date.now();
  fs.writeFileSync(path.join(dir, "claim.json"), JSON.stringify({ claim, account, started, checkout: o.checkout }, null, 1));
  fs.writeFileSync(path.join(dir, "prompt.md"), claim.turns[0]);
  fs.writeFileSync(path.join(dir, "then.md"), claim.turns[1]);
  const agent = claim.judge.agent;
  if (agent.claude_md) fs.writeFileSync(path.join(dir, "CLAUDE.md"), agent.claude_md);
  const run = path.join(dir, "run");
  const argv = [
    o.harness, "--run", run, "--prompt", path.join(dir, "prompt.md"), "--then", path.join(dir, "then.md"),
    "--model", claim.judge.model, "--max-turns", String(agent.max_turns), "--tools", agent.tools.join(","),
    "--cwd", path.join(o.checkout, agent.cwd), "--read-only", "--account", account,
    ...(agent.claude_md ? ["--claude-md", path.join(dir, "CLAUDE.md")] : []),
  ];
  const home = os.homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The harness's guard hands reads to the first real `cast` on PATH (a script that runs bun), and a daemon started by launchd has neither there.
  const env = reviewEnv(process.env, { ...o.gatewayEnv, DRY_RUN_HIDE_REGEX: `^${home}/.*/\\.env`, PATH: [o.castDir, path.dirname(bunPath()), process.env.PATH].filter(Boolean).join(path.delimiter) });
  const out = fs.openSync(path.join(dir, "harness.log"), "w");
  const child = spawn(bunPath(), argv, { cwd: dir, env, stdio: ["ignore", out, out], detached: true });
  // A review is batch work nobody waits on. At the default priority a dozen of
  // them held the CPU at 1% idle beside message delivery and the desktop app
  // (2026-10-23); niced, they take what interactive work leaves. Everything
  // the run starts inherits it.
  if (child.pid) try { os.setPriority(child.pid, REVIEW_NICE); } catch {}
  fs.writeFileSync(path.join(dir, "pid"), `${child.pid}\n`);
  child.unref();
  fs.closeSync(out);
  return { dir, claim, account, started, checkout: o.checkout };
}

const LIMIT_WORDS = /usage limit|limit reached|rate limit|429|overloaded|out of extra usage|hit your (?:\w+ )?limit/i;

/** What a finished (or dead) run hands back to `/cli/reviews/done`. */
export function handBack(files: RunFiles, now = Date.now()): Record<string, unknown> {
  const run = path.join(files.dir, "run");
  const out1 = readJson(path.join(run, "out.json"));
  const out2 = readJson(path.join(run, "out2.json"));
  const exit = fs.existsSync(path.join(run, "exit.txt")) ? Number(fs.readFileSync(path.join(run, "exit.txt"), "utf8").trim()) : null;
  const read = (f: string) => (fs.existsSync(path.join(run, f)) ? fs.readFileSync(path.join(run, f), "utf8") : "");
  const transcript: ReviewTranscript = {
    review: files.claim.review,
    moment: files.claim.moment,
    judge: files.claim.judge.name,
    model: files.claim.judge.model,
    turns: [transcriptFromStream(files.claim.turns[0], read("stream.jsonl")), ...(out2 || read("stream2.jsonl") ? [transcriptFromStream(files.claim.turns[1], read("stream2.jsonl"))] : [])],
  };
  const usageOf = (o: any) => ({ input: Number(o?.usage?.input_tokens ?? 0), output: Number(o?.usage?.output_tokens ?? 0), cache_read: Number(o?.usage?.cache_read_input_tokens ?? 0), cache_write: Number(o?.usage?.cache_creation_input_tokens ?? 0) });
  const u1 = usageOf(out1);
  const u2 = usageOf(out2);
  const usage = { input: u1.input + u2.input, output: u1.output + u2.output, cache_read: u1.cache_read + u2.cache_read, cache_write: u1.cache_write + u2.cache_write };
  // A resumed turn reports the session's cost so far, the first turn's included: the session's cost is the last turn's.
  const first = Number(out1?.total_cost_usd) || 0;
  const notional = out2 ? Math.max(first, Number(out2.total_cost_usd) || 0) : first;
  const ok = !!out1 && !out1.is_error && !!out2 && !out2.is_error && typeof out2.result === "string";
  const said = [out1?.result, out2?.result, read("err.txt"), read("../harness.log").slice(-2000)].filter((x) => typeof x === "string").join("\n");
  const error = ok ? undefined
    : !out1 ? `the review session ended without a result (harness exit ${exit ?? "none"}): ${read("../harness.log").trim().split("\n").slice(-3).join(" ").slice(0, 300)}`
      : out1.is_error ? `the review turn ended in an error: ${String(out1.result ?? out1.subtype ?? "").slice(0, 300)}`
        : `the findings turn ended without an answer: ${String(out2?.result ?? out2?.subtype ?? "no turn 2").slice(0, 300)}`;
  return {
    review: files.claim.review,
    ok,
    ...(error ? { error, ...(LIMIT_WORDS.test(said) ? { retry: true } : {}) } : {}),
    ...(ok ? { findings_text: out2.result } : {}),
    transcript_gz: gzipSync(Buffer.from(JSON.stringify(transcript))).toString("base64"),
    account: files.account,
    took_ms: now - files.started,
    turns: (Number(out1?.num_turns) || 0) + (Number(out2?.num_turns) || 0),
    usage,
    notional_usd: Math.round(notional * 10_000) / 10_000,
    ...(out2 ? { findings_turn_usd: Math.round((notional - first) * 10_000) / 10_000 } : {}),
  };
}

/** Every run directory this machine holds and has not handed back, with whether its harness still runs. */
export function heldRuns(): Array<RunFiles & { alive: boolean; exited: boolean }> {
  if (!fs.existsSync(runsDir())) return [];
  return fs.readdirSync(runsDir()).flatMap((name) => {
    const dir = path.join(runsDir(), name);
    const meta = readJson(path.join(dir, "claim.json"));
    if (!meta?.claim) return [];
    const pid = Number(fs.existsSync(path.join(dir, "pid")) ? fs.readFileSync(path.join(dir, "pid"), "utf8").trim() : 0);
    return [{ dir, claim: meta.claim, account: meta.account, started: meta.started, checkout: meta.checkout ?? "", alive: !!pid && pidAlive(pid), exited: fs.existsSync(path.join(dir, "run", "exit.txt")) }];
  });
}

function stopRun(dir: string) {
  const pid = Number(fs.existsSync(path.join(dir, "pid")) ? fs.readFileSync(path.join(dir, "pid"), "utf8").trim() : 0);
  // The harness's process group: it takes its agent down with it.
  if (pid) try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
}

// ── A try ──

/**
 * Agent judge sessions run to their end on this machine, outside the runner:
 * `cast line judges try` on an agent judge. Each claim runs in its own
 * directory under `under` (never the runner's, so no pass hands it back),
 * on a saved profile with room, its gateway started from `root`. Nothing is
 * handed back or filed; each result is what handBack would have sent.
 */
export async function tryAgentReviews(claims: ReviewClaim[], o: { root: string; under: string; log: (line: string) => void; now?: () => number }): Promise<Array<{ claim: ReviewClaim; dir: string; result: ReturnType<typeof handBack> }>> {
  const now = o.now ?? Date.now;
  const harness = harnessScript();
  if (!harness) throw new Error("this cast has no dry-run harness beside it (packages/cli/scripts/prompt-dry-run.ts), so it cannot run an agent judge");
  const castDir = realCastDir();
  if (!castDir) throw new Error("no cast on this machine for the harness's guard to hand reads to");
  const cfg = readReviewsConfig();
  const busy = new Map<string, number>();
  for (const r of heldRuns().filter((h) => h.alive)) busy.set(r.account, (busy.get(r.account) ?? 0) + 1);
  const profiles = tokenProfiles(await readActiveCredentialAsync());
  const gatewayEnvs = new Map<string, Record<string, string>>();
  const runs: RunFiles[] = [];
  try {
    for (const claim of claims) {
      const account = rankAccounts(profiles, cfg, busy, cooling, now())[0];
      if (!account) throw new Error("no saved profile with a setup token has room for an agent judge session now (cast usage)");
      const gw = claim.judge.agent.gateway;
      if (gw && !gatewayEnvs.has(gw)) gatewayEnvs.set(gw, await gatewayFor(o.root, gw, o.log));
      runs.push(startRun(claim, account, { checkout: o.root, gatewayEnv: gw ? gatewayEnvs.get(gw)! : {}, harness, castDir, dir: path.join(o.under, claim.review) }));
      busy.set(account, (busy.get(account) ?? 0) + 1);
      o.log(`${claim.moment}: ${claim.judge.name} started on ${account}`);
    }
    // Running until its harness writes its exit, or its process is gone.
    const running = (dir: string) => !fs.existsSync(path.join(dir, "run", "exit.txt")) && pidAlive(Number(fs.existsSync(path.join(dir, "pid")) ? fs.readFileSync(path.join(dir, "pid"), "utf8").trim() : 0));
    while (runs.some((r) => running(r.dir) && now() < r.claim.deadline)) await new Promise((res) => setTimeout(res, 5_000));
    return runs.map((r) => {
      const late = running(r.dir);
      if (late) stopRun(r.dir);
      const result = handBack(r, now());
      if (late && !result.ok) result.error = `the session ran past its ${Math.round(r.claim.judge.agent.timeout_ms / 60_000)} minutes and was stopped`;
      return { claim: r.claim, dir: r.dir, result };
    });
  } catch (err) {
    for (const r of runs) stopRun(r.dir);
    throw err;
  } finally {
    stopGateways();
  }
}

// ── The pass ──

export type ReviewsTickDeps = {
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  deviceId: string;
  log: (line: string) => void;
  now?: () => number;
};

const cooling = new Map<string, number>();
let ticking = false;

/**
 * One pass: hand back what finished, stop what is past its deadline or no
 * longer this machine's, renew the rest, then fill free slots. Does nothing
 * on a machine whose slots are 0 and that holds no runs.
 */
export async function tickReviews(deps: ReviewsTickDeps): Promise<{ handed: number; started: number; running: number }> {
  const now = deps.now ?? Date.now;
  const cfg = readReviewsConfig();
  let held = heldRuns();
  if (!cfg.slots && !held.length) return { handed: 0, started: 0, running: 0 };
  const other = holdRunnerLock();
  if (other) { deps.log(`[REVIEWS] process ${other} runs reviews on this machine; this pass stands by`); return { handed: 0, started: 0, running: held.length }; }
  let handed = 0;
  for (const r of held) {
    const late = r.alive && now() > r.claim.deadline;
    if (late) stopRun(r.dir);
    if (r.alive && !late) continue;
    const body = handBack(r, now());
    const turn2 = Number(body.findings_turn_usd) || 0;
    if (late && !body.ok) body.error = `the review ran past its ${Math.round(r.claim.judge.agent.timeout_ms / 60_000)} minutes and was stopped`;
    if (body.retry) cooling.set(r.account, now() + 30 * 60_000);
    try {
      const reply = await deps.post("/cli/reviews/done", { device_id: deps.deviceId, ...body });
      deps.log(`[REVIEWS] ${r.claim.review} ${r.claim.moment} ${reply?.status ?? "?"}${reply?.findings !== undefined ? `, ${reply.findings} found` : ""}${reply?.error ? ` (${reply.error})` : ""} in ${Math.round(Number(body.took_ms) / 1000)}s on ${r.account}, $${Number(body.notional_usd).toFixed(2)} list of which the findings turn $${turn2.toFixed(2)}`);
      fs.rmSync(r.dir, { recursive: true, force: true });
      handed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[REVIEWS] ${r.claim.review}: handing back failed: ${message}`);
      // A review the server no longer gives this machine is not coming back: its directory goes.
      if (/not running on this machine/.test(message)) fs.rmSync(r.dir, { recursive: true, force: true });
    }
  }
  held = heldRuns().filter((r) => r.alive);
  if (held.length) {
    const { lost } = await deps.post("/cli/reviews/renew", { device_id: deps.deviceId, reviews: held.map((r) => r.claim.review) }).catch(() => ({ lost: [] as string[] }));
    for (const r of held.filter((h) => lost.includes(h.claim.review))) {
      stopRun(r.dir);
      fs.rmSync(r.dir, { recursive: true, force: true });
      deps.log(`[REVIEWS] ${r.claim.review}: no longer this machine's (cancelled or taken back); stopped`);
    }
    held = held.filter((r) => !lost.includes(r.claim.review));
  }
  const idle = cpuIdleShare();
  const slots = slotsNow(cfg, idle);
  if (slots < cfg.slots) deps.log(`[REVIEWS] CPU ${Math.round((idle ?? 0) * 100)}% idle: filling ${slots} of ${cfg.slots} slots`);
  const free = Math.max(0, slots - held.length);
  const harness = harnessScript();
  const castDir = realCastDir();
  if (!free || !harness) return { handed, started: 0, running: held.length };
  if (!castDir) { deps.log("[REVIEWS] no cast on this machine for the harness's guard to hand reads to; starting none"); return { handed, started: 0, running: held.length }; }
  const busy = new Map<string, number>();
  for (const r of held) busy.set(r.account, (busy.get(r.account) ?? 0) + 1);
  // Read once per tick, with the keychain read off the loop: a synchronous one
  // here held the daemon for over a second every tick under load.
  const profiles = tokenProfiles(await readActiveCredentialAsync());
  const pick = () => rankAccounts(profiles, cfg, busy, cooling, now());
  const room = (() => {
    let n = 0;
    for (const name of pick()) n += cfg.per_account - (busy.get(name) ?? 0);
    return n;
  })();
  const want = Math.min(free, room);
  if (!want) return { handed, started: 0, running: held.length };
  const claims: ReviewClaim[] = (await deps.post("/cli/reviews/claim", { device_id: deps.deviceId, slots: want })) ?? [];
  let started = 0;
  const inUse = new Set(held.map((r) => r.checkout));
  for (const claim of claims) {
    const account = pick()[0];
    try {
      if (!account) throw new Error("no saved profile has room");
      const root = cfg.roots?.[claim.source] ?? claim.judge.root;
      if (!root || !fs.existsSync(root)) throw new Error(`the judge's repo is not on this machine (${root || "no root"}); set it with cast line reviews run --root ${claim.source}=<path>`);
      const checkout = await checkoutFor(root, inUse, now());
      inUse.add(checkout);
      const gatewayEnv = claim.judge.agent.gateway ? await gatewayFor(root, claim.judge.agent.gateway, deps.log) : {};
      startRun(claim, account, { checkout, gatewayEnv, harness, castDir });
      busy.set(account, (busy.get(account) ?? 0) + 1);
      started++;
      deps.log(`[REVIEWS] ${claim.review} ${claim.moment} ${claim.subject} started on ${account}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[REVIEWS] ${claim.review}: could not start: ${message}`);
      await deps.post("/cli/reviews/done", { device_id: deps.deviceId, review: claim.review, ok: false, error: `could not start on ${deps.deviceId}: ${message}`.slice(0, 500), retry: true }).catch(() => {});
    }
  }
  return { handed, started, running: held.length + started };
}

/** The daemon's pass (daemon.ts): one at a time, so a slow claim never stacks. */
export async function daemonReviewsTick(opts: { siteUrl: string | null; token: string | null; deviceId: string; log: (line: string) => void }): Promise<void> {
  if (ticking || !opts.siteUrl || !opts.token) return;
  if (!readReviewsConfig().slots && !heldRuns().length) return;
  ticking = true;
  try {
    const post = async (route: string, body: Record<string, unknown>) => {
      const resp = await fetch(`${opts.siteUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: opts.token, ...body }) });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || (data && typeof data === "object" && "error" in data && !("status" in data))) throw new Error((data as any)?.error ?? `${route} answered ${resp.status}`);
      return data;
    };
    await tickReviews({ post, deviceId: opts.deviceId, log: opts.log });
  } finally {
    ticking = false;
  }
}
