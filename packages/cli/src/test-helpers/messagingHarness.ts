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
import { execSync, spawnSync } from "node:child_process";
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
  spawnSync("tmux", [
    "new-session", "-d", "-s", tmuxSession,
    "-x", "200", "-y", "50",
    "-c", cwd,
    "bash", "-c", `PATH='${shimDir}:'$PATH FAKE_CLAUDE_SESSION_ID='${sessionId}' exec claude`
  ], { env, stdio: "ignore" });
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
  try {
    const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", { encoding: "utf-8" });
    for (const name of out.split("\n").map(s => s.trim()).filter(Boolean)) {
      if (name.startsWith(prefix)) {
        try { execSync(`tmux kill-session -t ${name} 2>/dev/null`, { stdio: "ignore" }); } catch {}
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
