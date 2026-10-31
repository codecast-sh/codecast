// The plain-git worktree path (daemon.ts createWorktree's fallback when a repo has
// no workspace.toml): add the worktree under .codecast/worktrees, retrying git's
// lock contention, and copy the setup files a checkout needs.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, execSync, spawn } from "./proc.js";

/**
 * Run a command with stderr in a temp file rather than a pipe, and stdout
 * discarded. git runs hooks with its own stdout and stderr, so a post-checkout
 * hook that backgrounds a job (`npm run build:watch &`) leaves the job holding
 * any pipe git was given. Bun 1.4's sync spawns return only when every holder
 * of a piped stdout or stderr has closed it, and node's async ones wait for
 * 'close' on every runtime, so with a pipe the call outlasts git for as long
 * as the job lives. A file can be held without keeping the call open: both
 * return when the command exits. A failure carries the output as `stderr` and
 * appended to `message`, the way a piped call's would.
 */
type Stderr = { dir?: string; out?: string; fd?: number };
function openStderr(): Stderr {
  const held: Stderr = {};
  try {
    held.dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-exec-"));
    held.out = path.join(held.dir, "stderr");
    held.fd = fs.openSync(held.out, "w");
  } catch (err) {
    closeStderr(held);
    throw err;
  }
  return held;
}
function closeStderr(held: Stderr): string {
  let text = "";
  try { if (held.out) text = fs.readFileSync(held.out, "utf-8"); } catch { /* nothing was written */ }
  // A hook job still holding the file makes removal fail on Windows.
  try { if (held.fd !== undefined) fs.closeSync(held.fd); } catch { /* closed */ }
  try { if (held.dir) fs.rmSync(held.dir, { recursive: true, force: true }); } catch { /* left for the OS temp sweep */ }
  return text;
}
function failure(err: Error, stderr: string): Error {
  const text = stderr.trim();
  Object.assign(err, { stderr });
  if (text) err.message = `${err.message}\n${text}`;
  return err;
}

export function execFileSyncToFile(file: string, args: string[], options: { cwd?: string } = {}): void {
  const held = openStderr();
  try {
    execFileSync(file, args, { ...options, stdio: ["ignore", "ignore", held.fd!] });
  } catch (err) {
    throw failure(err as Error, closeStderr(held));
  }
  closeStderr(held);
}

/** The async twin of execFileSyncToFile: settles when the command exits, not when its stdio closes. */
export function execFileToFile(file: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let held: Stderr;
    try { held = openStderr(); } catch (err) { reject(err); return; }
    const child = spawn(file, args, { ...options, stdio: ["ignore", "ignore", held.fd!] });
    child.once("error", (err) => { closeStderr(held); reject(err); });
    child.once("exit", (code, signal) => {
      const stderr = closeStderr(held);
      if (code === 0) { resolve(); return; }
      reject(failure(Object.assign(new Error(`Command failed: ${[file, ...args].join(" ")}`), { code, status: code, signal }), stderr));
    });
  });
}

const CODECAST_WORKTREE_DIR = ".codecast/worktrees";

export interface WorktreeResult {
  worktreePath: string;
  worktreeName: string;
  worktreeBranch: string;
  portIndex: number;
}

export function createWorktreeLegacy(repoRoot: string, name: string, log: (message: string) => void): WorktreeResult | { error: string } {
  const worktreeDir = path.join(repoRoot, CODECAST_WORKTREE_DIR);
  const worktreePath = path.join(worktreeDir, name);
  const branchName = `codecast/${name}`;

  if (fs.existsSync(worktreePath)) {
    const existingBranch = (() => {
      try {
        return execSync(`git rev-parse --abbrev-ref HEAD`, {
          cwd: worktreePath, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"],
        }).trim();
      } catch { return branchName; }
    })();
    return {
      worktreePath,
      worktreeName: name,
      worktreeBranch: existingBranch,
      portIndex: assignPortIndex(repoRoot),
    };
  }

  fs.mkdirSync(worktreeDir, { recursive: true });

  // Retry loop to handle concurrent git lock contention
  let created = false;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      try { execSync(`sleep ${(200 + attempt * 300) / 1000}`, { stdio: "ignore" }); } catch {}
    }
    try {
      execFileSyncToFile("git", ["worktree", "add", "--no-track", "-b", branchName, worktreePath], { cwd: repoRoot });
      created = true;
      break;
    } catch (err) {
      // Branch already exists — try without -b
      try {
        execFileSyncToFile("git", ["worktree", "add", worktreePath, branchName], { cwd: repoRoot });
        created = true;
        break;
      } catch (err2) {
        lastErr = err2;
      }
    }
  }

  if (!created) {
    log(`[WORKTREE] Failed to create worktree: ${lastErr}`);
    const e = lastErr as { stderr?: string | Buffer; message?: string } | undefined;
    return { error: (e?.stderr?.toString().trim() || e?.message || String(lastErr)).split("\n").find((l) => /^(fatal|error):/.test(l.trim())) ?? (e?.message || String(lastErr)).split("\n")[0] };
  }

  // Remove large build artifact directories that bloat the worktree
  const LARGE_ARTIFACT_DIRS = ["packages/desktop/src-tauri/target"];
  for (const dir of LARGE_ARTIFACT_DIRS) {
    const fullPath = path.join(worktreePath, dir);
    if (fs.existsSync(fullPath)) {
      try { execSync(`/bin/rm -rf ${JSON.stringify(fullPath)}`, { stdio: "ignore" }); } catch {}
    }
  }

  copySetupFiles(repoRoot, worktreePath);

  return {
    worktreePath,
    worktreeName: name,
    worktreeBranch: branchName,
    portIndex: assignPortIndex(repoRoot),
  };
}

function assignPortIndex(repoRoot: string): number {
  const worktreeDir = path.join(repoRoot, CODECAST_WORKTREE_DIR);
  if (!fs.existsSync(worktreeDir)) return 0;
  const existing = fs.readdirSync(worktreeDir).filter(f => {
    try { return fs.statSync(path.join(worktreeDir, f)).isDirectory(); } catch { return false; }
  });
  return Math.min(existing.length - 1, 9);
}

function copySetupFiles(mainRoot: string, worktreePath: string): void {
  const configFile = path.join(mainRoot, ".wt-setup-files");
  const patterns = fs.existsSync(configFile)
    ? fs.readFileSync(configFile, "utf-8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    : [".env", ".env.local"];

  for (const pattern of patterns) {
    const src = path.join(mainRoot, pattern);
    const dest = path.join(worktreePath, pattern);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      const destDir = path.dirname(dest);
      fs.mkdirSync(destDir, { recursive: true });
      if (fs.statSync(src).isDirectory()) {
        execSync(`cp -r ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" });
      } else {
        fs.copyFileSync(src, dest);
      }
    } catch {}
  }
}
