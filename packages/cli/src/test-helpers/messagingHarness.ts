// Test harness for the message-delivery pipeline.
//
// Spawns a real tmux session running the fake-claude shim, so tests can
// exercise the daemon's `tryStartedTmux` / `injectViaTmux` paths against
// real tmux (paste-buffer semantics, send-keys, capture-pane) and a real
// JSONL file appearing under ~/.claude/projects/<encoded-cwd>/.
//
// What this is NOT: a full daemon-process harness. The daemon also has
// Convex subscriptions, file watchers, and IPC that aren't exercised here.
// Those need a Convex test backend, which is tracked as follow-up work.
// This harness covers the speedup PR's risk surface (the inject pipeline).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeShimScript, cleanupShimScript, type ShimOptions } from "./fakeClaudeShim.js";

export interface HarnessOptions extends ShimOptions {
  /** Working directory the shim runs in. Default: a temp dir. */
  cwd?: string;
  /** Extra PATH entries (beyond the shim dir + system PATH). */
  pathPrefix?: string[];
  /** Tmux session prefix. Default: "cc-claude-test". */
  tmuxPrefix?: string;
}

export interface Harness {
  tmuxSession: string;
  shimPath: string;
  cwd: string;
  sessionId: string;
  jsonlPath: string;
  capturePane(): string;
  paneHasPrompt(): boolean;
  tearDown(): void;
}

const ACTIVE_SESSIONS = new Set<string>();

export function spawnHarness(opts: HarnessOptions = {}): Harness {
  const tmuxPrefix = opts.tmuxPrefix ?? "cc-claude-test";
  const tmuxSession = `${tmuxPrefix}-${randomUUID().slice(0, 8)}`;
  const cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "codecast-test-cwd-"));
  const sessionId = opts.sessionId ?? randomUUID();
  const shimPath = writeShimScript({ ...opts, sessionId });

  // The shim must be discoverable as `claude` on PATH so an invocation of
  // `claude` lands on it. We do this by symlinking (or copying) it to a
  // dedicated dir whose name is `claude`-friendly and prepending to PATH.
  const shimDir = path.dirname(shimPath);
  const env: Record<string, string> = {
    ...process.env,
    PATH: [shimDir, ...(opts.pathPrefix ?? []), process.env.PATH ?? ""].join(":"),
    FAKE_CLAUDE_SESSION_ID: sessionId,
  };

  // Spawn tmux session in the target cwd, executing the shim.
  // Use bash -c (NOT -lc) to skip login-shell init files — saves 1–3s startup.
  // Pass the shim path explicitly so a missing PATH hop (sometimes seen under
  // bun:test's spawnSync env handling) doesn't silently produce an empty pane.
  const sessionAlive = (): boolean => {
    try {
      execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const spawnOnce = (): { status: number | null; stderr?: string; stdout?: string } => spawnSync("tmux", [
    "new-session", "-d", "-s", tmuxSession,
    "-x", "200", "-y", "50",
    "-c", cwd,
    "bash", "-c", `FAKE_CLAUDE_SESSION_ID='${sessionId}' exec '${shimPath}'`
  ], { env, encoding: "utf-8" });
  // Up to 3 spawn attempts. Under heavy load we observe the inner bash dying
  // before reaching the shim (tmux PTY setup race). Verify "alive after 250ms"
  // before declaring success — sleep first so a session that died right after
  // exec is detected and respawned.
  let lastErr = "";
  let spawned = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnOnce();
    if (r.status !== 0) {
      lastErr = `tmux new-session failed (status ${r.status}): ${r.stderr ?? ""} ${r.stdout ?? ""}`;
      // Try to clear any partial session that might be lingering before retry.
      try { execSync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`, { stdio: "ignore" }); } catch {}
      continue;
    }
    // Brief sync wait — uses the deadline-loop approach so the harness
    // doesn't return prematurely. 1s total max per attempt.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (sessionAlive()) { spawned = true; break; }
      execSync("sleep 0.05");
    }
    if (spawned) break;
    lastErr = "tmux session died within 1s of spawn";
    try { execSync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`, { stdio: "ignore" }); } catch {}
  }
  if (!spawned) {
    throw new Error(`harness spawn failed after 3 attempts: ${lastErr}`);
  }
  ACTIVE_SESSIONS.add(tmuxSession);

  const projectDirName = cwd.replace(/\//g, "-");
  const jsonlPath = path.join(os.homedir(), ".claude", "projects", projectDirName, `${sessionId}.jsonl`);

  return {
    tmuxSession,
    shimPath,
    cwd,
    sessionId,
    jsonlPath,
    capturePane(): string {
      try {
        return execSync(`tmux capture-pane -p -J -t ${tmuxSession} -S -50`, { encoding: "utf-8" });
      } catch {
        return "";
      }
    },
    paneHasPrompt(): boolean {
      const content = this.capturePane();
      return /❯|⏵/.test(content);
    },
    tearDown(): void {
      try { execSync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`, { stdio: "ignore" }); } catch {}
      ACTIVE_SESSIONS.delete(tmuxSession);
      cleanupShimScript(shimPath);
      try {
        fs.unlinkSync(jsonlPath);
        fs.rmdirSync(path.dirname(jsonlPath));
      } catch {}
      // Only remove cwd if we created it (matches /tmp prefix).
      if (cwd.startsWith(os.tmpdir())) {
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

/**
 * Polls until `predicate()` returns true, or `timeoutMs` elapses.
 * Returns the elapsed milliseconds for latency assertions.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const intervalMs = opts.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return Date.now() - start;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ""}`);
}

/**
 * Sweeps any tmux sessions left over by previous test runs (matching the
 * `cc-claude-test-*` pattern). Safe to call from beforeAll.
 */
export function sweepStaleSessions(prefix = "cc-claude-test"): void {
  // A wedged tmux client ignores SIGTERM and spins at 100% CPU forever (see
  // tmuxExec in daemon.ts). Without a timeout + SIGKILL here, a single bad
  // tmux interaction during `bun test` orphans a process that outlives the run.
  const TMUX_TIMEOUT_MS = 5000;
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
      timeout: TMUX_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const name of out.split("\n").map((s: string) => s.trim()).filter(Boolean)) {
      if (name.startsWith(prefix)) {
        try {
          execFileSync("tmux", ["kill-session", "-t", name], {
            timeout: TMUX_TIMEOUT_MS,
            killSignal: "SIGKILL",
            stdio: "ignore",
          });
        } catch {}
      }
    }
  } catch {}
}

/**
 * Reads JSONL messages from disk, filtering to user/assistant rows.
 * Returns parsed objects in file order.
 */
export function readJsonlMessages(jsonlPath: string): Array<{ type: string; text?: string; raw: any }> {
  if (!fs.existsSync(jsonlPath)) return [];
  const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
  const out: Array<{ type: string; text?: string; raw: any }> = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user") {
        const content = obj.message?.content;
        const text = typeof content === "string" ? content :
          Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : "";
        out.push({ type: "user", text, raw: obj });
      } else if (obj.type === "assistant") {
        const content = obj.message?.content;
        const text = Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("") : "";
        out.push({ type: "assistant", text, raw: obj });
      }
    } catch {}
  }
  return out;
}
