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
//   1. wait until the functions directory has been quiet for QUIET_MS;
//   2. refuse while the tree is behind origin/main (a snapshot push from a
//      stale tree deletes newer functions from prod, the 2026-07-15 outage);
//   3. take a signature of every file that ships;
//   4. run the whole-program typecheck (`cast check convex`; a plain tsc when
//      cast is not on PATH) and stop on any error;
//   5. push once (`convex dev --once`);
//   6. take the signature again. If it moved, the push may have bundled a
//      mid-edit state, so it is dirty again and goes around once more.
// Function logs keep streaming in the same pane through `convex logs`.
//
// The state machine is `Gate`, with every side effect injected, so the test
// beside this file drives it with fakes; `main` below wires the real ones.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { join, relative, sep } from "node:path";

export const QUIET_MS = 3_000;
export const STALE_RETRY_MS = 60_000;
export const FAILED_PUSH_RETRY_MS = 60_000;

/** Files whose change is worth a push. Codegen output is written BY the push
 *  and must not retrigger it; tests never ship; editors leave dotfiles. */
export function shipsToProd(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p.startsWith(".") || p === "_generated" || p === "node_modules")) return false;
  const last = parts[parts.length - 1] ?? "";
  if (/\.test\.[cm]?[jt]sx?$/.test(last)) return false;
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

export type CheckResult = { errors: number; diagnostics: string };

export type GateIO = {
  now: () => number;
  /** Is HEAD a superset of origin/main? */
  treeIsFresh: () => Promise<boolean>;
  signature: () => Promise<string>;
  typecheck: () => Promise<CheckResult>;
  /** Exit code of the push. */
  push: () => Promise<number>;
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
        if (!this.wasStale) this.io.log("REFUSING to push: this tree is BEHIND origin/main. Run: git pull — the push resumes on its own.");
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
      this.io.log("Typecheck green, pushing to prod…");
      const code = await this.io.push();
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

async function treeIsFresh(): Promise<boolean> {
  // Offline (fetch fails or hangs under load), judge by the last-known
  // origin/main rather than blocking local dev — the same rule dev.sh applies.
  await run(["git", "fetch", "origin", "--quiet"], { cwd: ROOT, timeoutMs: 20_000 });
  const r = await run(["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: ROOT, timeoutMs: 30_000 });
  return r.code === 0;
}

async function signature(): Promise<string> {
  const entries: { rel: string; mtimeMs: number; size: number }[] = [];
  for (const name of readdirSync(FUNCTIONS, { recursive: true }) as string[]) {
    const abs = join(FUNCTIONS, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    entries.push({ rel: relative(FUNCTIONS, abs).split(sep).join("/"), mtimeMs: st.mtimeMs, size: st.size });
  }
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
  const r = await run([join(PKG, "node_modules", ".bin", "convex"), "dev", "--once"], { cwd: PKG, inherit: true, timeoutMs: 15 * 60_000 });
  return r.code;
}

function tailLogs(): void {
  // `convex dev` used to stream function logs into this pane; keep that.
  const child = spawn(join(PKG, "node_modules", ".bin", "convex"), ["logs"], { cwd: PKG, stdio: "inherit", env: process.env });
  child.on("close", () => setTimeout(tailLogs, 5_000));
}

async function main(): Promise<void> {
  if (!existsSync(FUNCTIONS)) throw new Error(`no functions directory at ${FUNCTIONS}`);
  const gate = new Gate({ now: Date.now, treeIsFresh, signature, typecheck, push, log });
  watch(FUNCTIONS, { recursive: true }, (_event, filename) => {
    const rel = filename == null ? undefined : String(filename).split(sep).join("/");
    if (rel === undefined || shipsToProd(rel)) gate.onChange(rel);
  });
  log(`Watching ${relative(ROOT, FUNCTIONS)}: a push waits ${QUIET_MS / 1000}s of quiet, a fresh tree and a green typecheck.`);
  tailLogs();
  for (;;) {
    await gate.tick();
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
