// THE GATED CONVEX PUSHER: what dev.sh runs instead of a raw `convex dev`.
//
// `convex dev` pushes the working tree to PROD on every save. Its typecheck
// does not make that safe: the CLI bundles the tree, THEN runs tsc against the
// disk, so two saves inside one push window can bundle a broken state and
// typecheck a fixed one. On 2026-09-21 that shipped a getTeamMembers with its
// `feedFilter` declaration removed and its use still present, and every open
// avatar bar latched "Failed to load" on the ReferenceError.
//
// This pusher makes a push a proof instead of a reflex:
//   1. wait until everything the backend bundles (the functions directory,
//      packages/shared and platform/packages) has been quiet for QUIET_MS;
//   2. refuse while the tree is behind origin/main (a snapshot push from a
//      stale tree deletes newer functions from prod, the 2026-07-15 outage);
//   3. take a signature of every file that ships;
//   4. run the whole-program typecheck (`cast check convex`; a plain tsc when
//      cast is not on PATH) and stop on any error;
//   5. push once (`convex dev --once --typecheck disable`);
//   6. take the signature again. If it moved, the push may have bundled a
//      mid-edit state, so it is dirty again and goes around once more.
// Around the push it also says what prod gains and loses: before it, the
// diff against prod (scripts/prod-diff.ts) prints what the push would take
// off prod and which recorded push put each thing there; after it, the push
// is recorded as a deploy (`cast ship mark --via "dev watcher"`) with this
// machine, the uncommitted file count and those changes, so the next deploy
// that drops this work can name who to tell. Neither ever blocks a push.
// Function logs keep streaming in the same pane through `convex logs`.
//
// The state machine is `Gate`, with every side effect injected, so the test
// beside this file drives it with fakes; `main` below wires the real ones.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export const QUIET_MS = 3_000;
export const STALE_RETRY_MS = 60_000;
export const FAILED_PUSH_RETRY_MS = 60_000;

/** Files whose change is worth a push. Codegen output is written BY the push
 *  and must not retrigger it; tests and their fixtures (`*.testkit.ts`,
 *  `*.testing.ts`) never ship; editors leave dotfiles. `rel` is relative to
 *  the functions directory, or repo-relative for the other bundled sources. */
export function shipsToProd(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith(".") || p === "_generated" || p === "node_modules")) return false;
  const last = parts[parts.length - 1] ?? "";
  if (/\.(test|testkit|testing)\.[cm]?[jt]sx?$/.test(last)) return false;
  return /\.[cm]?[jt]sx?$|\.json$/.test(last);
}

/** One string that changes when any shipping file's bytes could have. */
export function signatureOf(entries: Iterable<{ rel: string; mtimeMs: number; size: number }>): string {
  return [...entries]
    .filter((e) => shipsToProd(e.rel))
    .map((e) => `${e.rel}\u0000${Math.round(e.mtimeMs)}\u0000${e.size}`)
    .sort()
    .join("\n");
}

/** Every directory the backend bundles, the same set deploy.sh reads: the
 *  functions, the shared package they import (`@codecast/shared`) and the
 *  vendored platform packages. `prefix` namespaces a file in the signature
 *  and the log; functions keep their bare path. */
export function bundledSources(root: string): { dir: string; prefix: string }[] {
  return [
    { dir: join(root, "packages", "convex", "convex"), prefix: "" },
    { dir: join(root, "packages", "shared"), prefix: "packages/shared/" },
    { dir: join(root, "platform", "packages"), prefix: "platform/packages/" },
  ];
}

export type CheckResult = { errors: number; diagnostics: string };

/** What a push puts on prod and takes off it, by name (scripts/prod-diff.ts). */
export type PushChanges = { adds: string[]; drops: string[] };

export type GateIO = {
  now: () => number;
  /** Is HEAD a superset of `base`? */
  treeIsFresh: () => Promise<boolean>;
  /** The ref freshness is judged against, for the log. Defaults to origin/main. */
  base?: string;
  signature: () => Promise<string>;
  typecheck: () => Promise<CheckResult>;
  /** Exit code of the push. */
  push: () => Promise<number>;
  /** What the push would change on prod, printed for the person; null when prod or the tree can't be read. */
  diff: () => Promise<PushChanges | null>;
  /** Record a push that went out as a deploy. Must not throw: a push is never undone by its record. */
  record: (changes: PushChanges | null) => Promise<void>;
  log: (line: string) => void;
};

export class Gate {
  private dirty = true; // a fresh pusher pushes once, the way `convex dev` did
  private lastChangeAt: number;
  private retryAt = 0;
  private busy = false;
  private wasStale = false;
  pushes = 0;

  constructor(private io: GateIO) {
    this.lastChangeAt = io.now() - QUIET_MS; // startup: no quiet wait
  }

  /** A shipping file changed on disk. */
  onChange(rel?: string): void {
    if (rel !== undefined && !shipsToProd(rel)) return;
    this.dirty = true;
    this.lastChangeAt = this.io.now();
    this.retryAt = 0;
  }

  /** One turn of the loop. Returns what it did, for the log and the tests. */
  async tick(): Promise<"idle" | "quiet" | "stale" | "errors" | "pushed" | "failed" | "moved"> {
    if (this.busy || !this.dirty) return "idle";
    const now = this.io.now();
    if (now - this.lastChangeAt < QUIET_MS || now < this.retryAt) return "quiet";
    this.busy = true;
    try {
      if (!(await this.io.treeIsFresh())) {
        if (!this.wasStale) {
          const base = this.io.base ?? "origin/main";
          this.io.log(`REFUSING to push: this tree is BEHIND ${base}. Run: git pull --rebase ${base.replace("/", " ")} — the push resumes on its own.`);
        }
        this.wasStale = true;
        this.retryAt = this.io.now() + STALE_RETRY_MS;
        return "stale";
      }
      if (this.wasStale) this.io.log("Tree is fresh again.");
      this.wasStale = false;

      const before = await this.io.signature();
      const check = await this.io.typecheck();
      if (check.errors > 0) {
        this.io.log(`NOT pushing: ${check.errors} type error(s) in the convex program. Prod keeps the last good push.`);
        for (const line of check.diagnostics.split("\n")) if (line.trim()) this.io.log(`  ${line}`);
        // Wait for the next save; a red tree does not change by itself.
        this.dirty = false;
        return "errors";
      }

      this.dirty = false;
      this.io.log("Typecheck green.");
      const changes = await this.io.diff();
      this.io.log("Pushing to prod…");
      const code = await this.io.push();
      // A push that went out changed prod, even one that has to go around again.
      if (code === 0) await this.io.record(changes);
      const after = await this.io.signature();
      if (after !== before) {
        this.io.log("Files changed while the push ran; that push may hold a mid-edit state, pushing again after the tree settles.");
        this.dirty = true;
        this.lastChangeAt = this.io.now();
        return "moved";
      }
      if (code !== 0) {
        this.io.log(`Push failed (exit ${code}). Retrying in ${FAILED_PUSH_RETRY_MS / 1000}s, or on the next save.`);
        this.dirty = true;
        this.retryAt = this.io.now() + FAILED_PUSH_RETRY_MS;
        return "failed";
      }
      this.pushes += 1;
      this.io.log("Pushed.");
      return "pushed";
    } finally {
      this.busy = false;
    }
  }
}

// ---- the real IO -----------------------------------------------------------

const PKG = join(import.meta.dir, "..");
const ROOT = join(PKG, "..", "..");
const FUNCTIONS = join(PKG, "convex");
const SOURCES = bundledSources(ROOT);

function stamp(): string {
  return new Date().toTimeString().slice(0, 8);
}
function log(line: string): void {
  console.log(`\x1b[90m[${stamp()}]\x1b[0m \x1b[36mconvex-push\x1b[0m ${line}`);
}

function run(cmd: string[], opts: { cwd: string; timeoutMs?: number; inherit?: boolean }): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      cwd: opts.cwd,
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    let stdout = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs) : null;
    child.on("error", () => { if (timer) clearTimeout(timer); resolve({ code: 127, stdout }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
  });
}

// The remote freshness is judged against: codecast-sh/codecast's, not a
// fork's origin, which can sit far behind it while looking fresh.
async function baseRemote(): Promise<string> {
  const r = await run(["bash", join(ROOT, "scripts", "convex-base-remote.sh")], { cwd: ROOT, timeoutMs: 10_000 });
  return (r.code === 0 && r.stdout.trim()) || "origin";
}

function treeIsFreshAgainst(remote: string): () => Promise<boolean> {
  return async () => {
    // Offline (fetch fails or hangs under load), judge by the last-known
    // <remote>/main rather than blocking local dev — the same rule dev.sh applies.
    await run(["git", "fetch", remote, "--quiet"], { cwd: ROOT, timeoutMs: 20_000 });
    const r = await run(["git", "merge-base", "--is-ancestor", `${remote}/main`, "HEAD"], { cwd: ROOT, timeoutMs: 30_000 });
    return r.code === 0;
  };
}

async function signature(): Promise<string> {
  const entries: { rel: string; mtimeMs: number; size: number }[] = [];
  // Walk by hand so dependency and dot directories are never descended into.
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules" || name === "_generated") continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, `${prefix}${name}/`);
      else if (st.isFile()) entries.push({ rel: `${prefix}${name}`, mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  for (const source of SOURCES) walk(source.dir, source.prefix);
  // The package manifest ships too (a dependency change re-bundles).
  const pkg = statSync(join(PKG, "package.json"));
  entries.push({ rel: "package.json", mtimeMs: pkg.mtimeMs, size: pkg.size });
  return signatureOf(entries);
}

async function typecheck(): Promise<CheckResult> {
  const viaCast = await run(["cast", "check", "convex", "--json"], { cwd: ROOT, timeoutMs: 10 * 60_000 });
  if (viaCast.code !== 127) {
    try {
      const rows = JSON.parse(viaCast.stdout) as CheckResult[];
      const row = rows.find((r: any) => r.project === "convex") ?? rows[0];
      if (row && typeof row.errors === "number") return { errors: row.errors, diagnostics: row.diagnostics ?? "" };
    } catch { /* fall through to a plain tsc */ }
  }
  const tsc = await run([join(PKG, "node_modules", ".bin", "tsc"), "--noEmit", "-p", join(FUNCTIONS, "tsconfig.json")], { cwd: PKG, timeoutMs: 10 * 60_000 });
  return { errors: tsc.code === 0 ? 0 : 1, diagnostics: tsc.stdout };
}

async function push(): Promise<number> {
  // Step 4 already proved the tree green; the CLI's own pass would be a second fresh whole-program tsc per push.
  const r = await run([join(PKG, "node_modules", ".bin", "convex"), "dev", "--once", "--typecheck", "disable"], { cwd: PKG, inherit: true, timeoutMs: 15 * 60_000 });
  return r.code;
}

async function diff(): Promise<PushChanges | null> {
  // The summary (and each drop's adder) prints on stderr, straight into this pane.
  const r = spawn("bun", [join(PKG, "scripts", "prod-diff.ts"), "--json"], { cwd: PKG, stdio: ["ignore", "pipe", "inherit"], env: process.env });
  let stdout = "";
  r.stdout?.on("data", (d) => { stdout += d; });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => r.kill("SIGTERM"), 3 * 60_000);
    r.on("error", () => { clearTimeout(timer); resolve(127); });
    r.on("close", (c) => { clearTimeout(timer); resolve(c ?? 1); });
  });
  if (code !== 0) {
    log("Could not read what this push changes on prod; pushing without that check.");
    return null;
  }
  try {
    const { adds, drops } = JSON.parse(stdout);
    return { adds, drops };
  } catch {
    return null;
  }
}

/** Uncommitted files under what the backend bundles: the count deploy.sh records. */
async function uncommittedCount(): Promise<number> {
  const r = await run(["git", "status", "--porcelain", "--", "packages/convex/convex", "packages/shared", "platform/packages"], { cwd: ROOT, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.split("\n").filter((l) => l.trim()).length : 0;
}

/** The `cast ship mark` that records a watcher push, or null when this cast
 *  can't say the push came from the watcher (no `--via`): a plain mark would
 *  read as a deploy, finishing and superseding the line's deploys and firing
 *  deploy triggers on every save. */
export function watcherMarkArgs(markHelp: string, sha: string, dirty: number, changesFile?: string): string[] | null {
  if (!markHelp.includes("--changes")) return null;
  return ["cast", "ship", "mark", "--surface", "backend", "--sha", sha, "--via", "dev watcher",
    ...(dirty > 0 ? ["--dirty", String(dirty)] : []), ...(changesFile ? ["--changes", changesFile] : [])];
}

let markHelp: string | null = null;

async function record(changes: PushChanges | null): Promise<void> {
  try {
    if (markHelp === null) {
      const help = await run(["cast", "ship", "mark", "--help"], { cwd: ROOT, timeoutMs: 15_000 });
      markHelp = help.code === 0 ? help.stdout : "";
    }
    if (!watcherMarkArgs(markHelp, "", 0)) return log("Push not recorded: this cast is older than `cast ship mark --via`; update cast to record watcher pushes.");
    const head = await run(["git", "rev-parse", "HEAD"], { cwd: ROOT, timeoutMs: 10_000 });
    const sha = head.stdout.trim();
    if (head.code !== 0 || !sha) return log("Push not recorded: no HEAD commit.");
    const dirty = await uncommittedCount();
    const dir = changes ? mkdtempSync(join(tmpdir(), "convex-push-")) : null;
    try {
      if (dir) writeFileSync(join(dir, "changes.json"), JSON.stringify(changes));
      const r = await run(watcherMarkArgs(markHelp, sha, dirty, dir ? join(dir, "changes.json") : undefined)!, { cwd: ROOT, timeoutMs: 30_000 });
      log(r.code === 0 ? `Recorded this push${dirty ? ` (${dirty} uncommitted file${dirty === 1 ? "" : "s"})` : ""}.` : "Push not recorded (cast missing, logged out or offline); the push itself went out.");
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    log(`Push not recorded: ${(e as Error)?.message ?? e}`);
  }
}

function tailLogs(): void {
  // `convex dev` used to stream function logs into this pane; keep that.
  const child = spawn(join(PKG, "node_modules", ".bin", "convex"), ["logs"], { cwd: PKG, stdio: "inherit", env: process.env });
  child.on("close", () => setTimeout(tailLogs, 5_000));
}

async function main(): Promise<void> {
  if (!existsSync(FUNCTIONS)) throw new Error(`no functions directory at ${FUNCTIONS}`);
  const remote = await baseRemote();
  const gate = new Gate({ now: Date.now, treeIsFresh: treeIsFreshAgainst(remote), base: `${remote}/main`, signature, typecheck, push, diff, record, log });
  for (const source of SOURCES) {
    if (!existsSync(source.dir)) continue;
    watch(source.dir, { recursive: true }, (_event, filename) => {
      const rel = filename == null ? undefined : source.prefix + String(filename).split(sep).join("/");
      if (rel === undefined || shipsToProd(rel)) gate.onChange(rel);
    });
  }
  log(`Watching ${SOURCES.map((s) => relative(ROOT, s.dir)).join(", ")}: a push waits ${QUIET_MS / 1000}s of quiet, a tree not behind ${remote}/main and a green typecheck.`);
  tailLogs();
  for (;;) {
    await gate.tick();
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
