// The host half of bringing moments (docs/architecture/learning-loop.md LL7).
// A product's extractor is code in its repo, .codecast/moments/<kind>.ts,
// that reads the product's own read-only data and prints one moment as JSON.
// The machine that published it runs it: the daemon claims due moments, runs
// each extractor in the checkout the way a line station runs a script (its
// own process, the checkout as cwd, a timeout), and hands the output back.
//
// A source keeps moment bodies on this host unless a person chose codecast
// storage. Here they are written under ~/.local/share/codecast/moments-shadow
// and dropped after 30 days; the server reads them only in hand, to judge.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, findOnPath, TOOL_PATH, execFileAsync } from "./proc.js";
import { codecastPath } from "./codecastDir.js";
import { MOMENT_LIMITS, type ExtractorInput } from "@codecast/shared/contracts/moments";

export const MOMENTS_DIR = ".codecast/moments";
export const JUDGES_DIR = ".codecast/judges";

/** Where this machine notes the checkouts it published extractors from; the daemon claims only when it holds one. */
export function hostFile(): string {
  return codecastPath("moments-host.json");
}

/** Where host-kept moment bodies live. */
export function shadowDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "codecast", "moments-shadow");
}

export function readHostRoots(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(hostFile(), "utf8"));
    return Array.isArray(parsed?.roots) ? parsed.roots.filter((r: unknown) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/** Notes (or forgets, with no extractors) a checkout this machine extracts for. */
export function noteHostRoot(root: string, extracts: boolean): void {
  const roots = new Set(readHostRoots());
  if (extracts) roots.add(root);
  else roots.delete(root);
  fs.mkdirSync(path.dirname(hostFile()), { recursive: true });
  fs.writeFileSync(hostFile(), JSON.stringify({ roots: [...roots] }, null, 2) + "\n");
}

/** The file's git blob sha: the extractor's or judge's version, the same before and after a commit. */
export async function fileVersion(file: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["hash-object", file], { cwd: path.dirname(file), encoding: "utf8" } as any);
  return String(stdout).trim();
}

export type MomentClaim = {
  moment: string;
  source: string;
  input: ExtractorInput;
  extractor: { path: string; root: string; version: string; timeout_ms: number };
  storage: "host" | "codecast";
};

export type ExtractResult = { output?: string; error?: string; version: string };

function bunPath(): string {
  return findOnPath("bun", [TOOL_PATH, path.join(os.homedir(), ".bun", "bin")].join(path.delimiter)) ?? "bun";
}

/**
 * Runs one extractor on one claim: `bun <file>` in the checkout with the
 * event on stdin. Its stdout is the moment; a non-zero exit, a timeout or
 * output past the moment's size cap is a failure with the reason in words.
 */
export async function runExtractor(claim: MomentClaim, opts: { bun?: string } = {}): Promise<ExtractResult> {
  const file = path.join(claim.extractor.root, claim.extractor.path);
  if (!fs.existsSync(file)) return { error: `${claim.extractor.path} is not in ${claim.extractor.root}`, version: claim.extractor.version };
  const version = await fileVersion(file).catch(() => claim.extractor.version);
  return await new Promise<ExtractResult>((resolve) => {
    const child = spawn(opts.bun ?? bunPath(), [file], { cwd: claim.extractor.root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODECAST_MOMENT: claim.moment } });
    let out = "";
    let err = "";
    let over = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ error: `the extractor ran past ${Math.round(claim.extractor.timeout_ms / 1000)}s`, version });
    }, claim.extractor.timeout_ms);
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > MOMENT_LIMITS.json_bytes && !over) {
        over = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr!.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-4000); });
    child.on("error", (e: Error) => { clearTimeout(timer); resolve({ error: e.message, version }); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (over) return resolve({ error: `the moment is over ${MOMENT_LIMITS.json_bytes} bytes`, version });
      if (code !== 0) return resolve({ error: `the extractor exited ${code}: ${err.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`, version });
      resolve({ output: out, version });
    });
    child.stdin!.end(JSON.stringify(claim.input));
  });
}

/** A host-kept body, written where only this machine reads it. */
export function keepOnHost(claim: MomentClaim, output: string, version: string, now: number): string {
  const dir = path.join(shadowDir(), claim.source.replace(/[^A-Za-z0-9_-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${claim.moment}.json`);
  fs.writeFileSync(file, JSON.stringify({ moment: claim.moment, input: claim.input, extractor: { path: claim.extractor.path, version }, extracted_at: now, output: JSON.parse(output) }, null, 2) + "\n", { mode: 0o600 });
  return file;
}

/** Host-kept bodies past 30 days go, the same retention codecast storage has. */
export function pruneHostMoments(now: number): number {
  let removed = 0;
  const root = shadowDir();
  for (const source of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, source);
    for (const name of fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []) {
      const file = path.join(dir, name);
      if (now - fs.statSync(file).mtimeMs > MOMENT_LIMITS.retention_ms) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    }
  }
  return removed;
}

export type MomentsTickDeps = {
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  deviceId: string;
  now?: () => number;
  log?: (line: string) => void;
  run?: (claim: MomentClaim) => Promise<ExtractResult>;
};

/**
 * One pass: claim what is due on this machine, extract each, keep host
 * bodies here, and hand every result back (the server stores and judges).
 * Returns what happened per moment.
 */
export async function tickMoments(deps: MomentsTickDeps): Promise<Array<{ moment: string; status: string; error?: string }>> {
  const now = deps.now ?? Date.now;
  const claims: MomentClaim[] = (await deps.post("/cli/moments/claim", { device_id: deps.deviceId })) ?? [];
  const out: Array<{ moment: string; status: string; error?: string }> = [];
  for (const claim of claims) {
    const result = await (deps.run ?? runExtractor)(claim);
    if (result.output !== undefined && claim.storage === "host") {
      try {
        keepOnHost(claim, result.output, result.version, now());
      } catch (err) {
        result.error = `could not keep the moment on this machine: ${err instanceof Error ? err.message : String(err)}`;
        delete result.output;
      }
    }
    const reply = await deps.post("/cli/moments/complete", {
      device_id: deps.deviceId,
      moment: claim.moment,
      extractor_version: result.version,
      ...(result.output !== undefined ? { output: result.output } : { error: result.error ?? "the extractor printed nothing" }),
    }).catch((err: unknown) => ({ status: "unreported", error: err instanceof Error ? err.message : String(err) }));
    out.push({ moment: claim.moment, status: reply?.status ?? "unreported", ...(reply?.error ? { error: reply.error } : {}) });
    deps.log?.(`[MOMENTS] ${claim.moment} ${claim.input.kind}/${claim.input.subject}: ${reply?.status ?? "unreported"}${reply?.error ? ` (${reply.error})` : ""}`);
  }
  return out;
}

/** How often the daemon looks for due moments; only a machine that published extractors asks. */
export const MOMENTS_TICK_MS = 60_000;
let lastPrune = 0;
let ticking = false;

/**
 * The daemon's pass (daemon.ts): nothing unless this machine published
 * extractors; then prune host bodies once a day and run what is due. One
 * pass at a time, so a slow extractor never stacks claims.
 */
export async function daemonMomentsTick(opts: { siteUrl: string | null; token: string | null; deviceId: string; log: (line: string) => void }): Promise<void> {
  if (ticking || !opts.siteUrl || !opts.token || !readHostRoots().length) return;
  ticking = true;
  try {
    const now = Date.now();
    if (now - lastPrune > 24 * 60 * 60_000) {
      lastPrune = now;
      const removed = pruneHostMoments(now);
      if (removed) opts.log(`[MOMENTS] removed ${removed} host moment${removed === 1 ? "" : "s"} past 30 days`);
    }
    const post = async (route: string, body: Record<string, unknown>) => {
      const resp = await fetch(`${opts.siteUrl}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_token: opts.token, ...body }) });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || (data && typeof data === "object" && "error" in data && !("status" in data))) throw new Error((data as any)?.error ?? `${route} answered ${resp.status}`);
      return data;
    };
    await tickMoments({ post, deviceId: opts.deviceId, log: opts.log });
  } finally {
    ticking = false;
  }
}
