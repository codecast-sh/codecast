// The plain-git worktree path (daemon.ts createWorktree's fallback when a repo has
// no workspace.toml): add the worktree under .codecast/worktrees, retrying git's
// lock contention, and copy the setup files a checkout needs.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, execSync } from "./proc.js";

/**
 * Runs a command synchronously with its output in a temp file rather than a
 * pipe. Bun 1.4 returns from a sync spawn only when every holder of a piped
 * stdout or stderr has closed it, so a command whose child outlives it (git
 * runs a post-checkout hook that backgrounds `npm run build:watch &` with git's
 * own stdout and stderr) keeps the daemon's event loop in the call for as long
 * as the job lives. With a file the call returns when the command exits. On
 * failure the error carries the output as `stderr`, as a piped call's would.
 */
export function execFileSyncToFile(file: string, args: string[], options: { cwd?: string } = {}): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-exec-"));
  const out = path.join(dir, "out");
  const fd = fs.openSync(out, "w");
  try {
    execFileSync(file, args, { ...options, stdio: ["ignore", fd, fd] });
  } catch (err) {
    (err as { stderr?: string }).stderr = fs.readFileSync(out, "utf-8");
    throw err;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
