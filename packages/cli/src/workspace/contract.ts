/**
 * Workspace contract validator + state persistence.
 *
 * The contract is the load-bearing concept: when a workspace is in state
 * "ready", agents can assume specific guarantees hold. This module both:
 *   (a) checks those guarantees against a live workspace, and
 *   (b) persists workspace state to disk so it survives daemon restarts.
 *
 * State location:
 *   <repoRoot>/.codecast/workspaces/<name>/state.json
 *
 * The state file is small (< 1KB) and intended to be queryable by both the
 * CLI (`cast workspace status`) and the daemon (for crash recovery).
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isPortFree } from "./ports.js";
import type {
  ChromeBinding,
  ContractCheck,
  ContractResult,
  Workspace,
  WorkspaceManifest,
  WorkspaceState,
} from "./types.js";

/** Convenctional location of per-workspace state files relative to repo root. */
export const WORKSPACES_STATE_DIR = ".codecast/workspaces";

/** Persisted state snapshot. A subset of Workspace minus mutable runtime fields. */
export interface PersistedWorkspaceState {
  name: string;
  path: string;
  branch: string;
  resourceIndex: number;
  state: WorkspaceState;
  manifest: WorkspaceManifest;
  ports: Record<string, number>;
  env: Record<string, string>;
  /** ISO timestamp of last state mutation. */
  updatedAt: string;
  /** Last contract result, if available. */
  contract?: ContractResult;
  /** Chrome process bound to this workspace, when browser.enabled. */
  chrome?: ChromeBinding;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function stateFilePath(repoRoot: string, name: string): string {
  return path.join(repoRoot, WORKSPACES_STATE_DIR, name, "state.json");
}

export function readState(repoRoot: string, name: string): PersistedWorkspaceState | null {
  const p = stateFilePath(repoRoot, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PersistedWorkspaceState;
  } catch {
    return null;
  }
}

export function writeState(repoRoot: string, state: PersistedWorkspaceState): void {
  const p = stateFilePath(repoRoot, state.name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write via temp + rename to avoid partial-state on crash.
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

export function deleteState(repoRoot: string, name: string): void {
  const dir = path.dirname(stateFilePath(repoRoot, name));
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function listStates(repoRoot: string): PersistedWorkspaceState[] {
  const dir = path.join(repoRoot, WORKSPACES_STATE_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: PersistedWorkspaceState[] = [];
  for (const entry of fs.readdirSync(dir)) {
    // Skip internal directories (leading underscore) — e.g., _pool/.
    if (entry.startsWith("_")) continue;
    const s = readState(repoRoot, entry);
    // Sanity check: ensure this looks like a workspace state file, not some
    // other JSON we accidentally landed on.
    if (s && typeof s.name === "string" && typeof s.path === "string") {
      out.push(s);
    }
  }
  return out;
}

/** Transition a workspace's persisted state. No-op if state file is missing. */
export function setState(
  repoRoot: string,
  name: string,
  next: WorkspaceState,
): PersistedWorkspaceState | null {
  const current = readState(repoRoot, name);
  if (!current) return null;
  current.state = next;
  current.updatedAt = new Date().toISOString();
  writeState(repoRoot, current);
  return current;
}

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

/**
 * Validate that a workspace meets the contract. Performs all checks even if
 * an early one fails so the result lists every problem at once.
 */
export async function validateContract(ws: Workspace): Promise<ContractResult> {
  const checks: ContractCheck[] = [];

  checks.push(check("worktree-exists", () => {
    if (!fs.existsSync(ws.path)) return "worktree directory missing";
    if (!fs.statSync(ws.path).isDirectory()) return "worktree path is not a directory";
    return null;
  }));

  checks.push(check("git-branch", () => {
    if (!fs.existsSync(path.join(ws.path, ".git"))) {
      return "no .git in worktree (not a git working tree)";
    }
    try {
      const actual = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: ws.path,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (actual !== ws.branch) {
        return `branch is '${actual}', expected '${ws.branch}'`;
      }
      return null;
    } catch (e) {
      return `git rev-parse failed: ${(e as Error).message}`;
    }
  }));

  // Dependency directories. We can only check ones we know about — the
  // detected install commands give us hints. The check is light: presence
  // of a directory, not its contents.
  checks.push(check("deps-installed", () => {
    const probes = depsProbes(ws.manifest);
    if (probes.length === 0) return null; // nothing to verify
    for (const probe of probes) {
      const p = path.join(ws.path, probe);
      if (fs.existsSync(p)) return null;
    }
    return `none of expected dep dirs found: ${probes.join(", ")}`;
  }));

  // Manifest env vars present in the workspace env.
  checks.push(check("env-vars", () => {
    const missing: string[] = [];
    for (const k of Object.keys(ws.manifest.env)) {
      if (!(k in ws.env)) missing.push(k);
    }
    if (missing.length > 0) return `missing env vars: ${missing.join(", ")}`;
    return null;
  }));

  // Each declared named port should appear in computed ports + env.
  for (const portName of Object.keys(ws.manifest.ports)) {
    checks.push(check(`port:${portName}`, () => {
      if (!(portName in ws.ports)) return "not allocated";
      const expectedEnv = `PORT_${portName.toUpperCase()}`;
      if (ws.env[expectedEnv] !== String(ws.ports[portName])) {
        return `env ${expectedEnv} missing or mismatched`;
      }
      return null;
    }));
  }

  // Run async port-free checks in parallel.
  for (const [portName, portNum] of Object.entries(ws.ports)) {
    const free = await isPortFree(portNum);
    checks.push({
      name: `port-free:${portName}`,
      ok: free,
      // Free is a positive condition for an unstarted workspace; if the
      // service-runner has started something on this port we expect NOT
      // free. For v1 we don't know which case applies, so we mark this
      // as a warning-style check that doesn't fail the contract.
      // (Bias toward "ok unless we're sure otherwise".)
      ...(free ? {} : { reason: `port ${portNum} in use (may be a running service, ok if expected)` }),
    });
  }

  // Aggregate (ignore warning-style port-free results since their meaning
  // depends on service state — see comment above).
  const failures = checks.filter((c) => !c.ok && !c.name.startsWith("port-free:"));
  return { ok: failures.length === 0, checks };
}

function check(name: string, fn: () => string | null): ContractCheck {
  try {
    const reason = fn();
    if (reason === null) return { name, ok: true };
    return { name, ok: false, reason };
  } catch (e) {
    return { name, ok: false, reason: (e as Error).message };
  }
}

/**
 * Probes for "deps installed" — in-worktree markers that an install command
 * is known to produce. Only high-confidence probes are listed. Commands that
 * write to user-global caches (e.g., `cargo fetch` → ~/.cargo, `go mod
 * download` → $GOPATH/pkg/mod) leave no in-worktree marker, so we skip the
 * check rather than fail it. The setup runner already verified the install
 * exited 0 — that's the strong signal.
 */
function depsProbes(m: WorkspaceManifest): string[] {
  const cmds = [...m.setup.install].join(" ");
  const probes: string[] = [];
  if (/\b(bun|npm|pnpm|yarn)\b/.test(cmds)) probes.push("node_modules");
  if (/\bcargo\s+build\b/.test(cmds)) probes.push("target");
  if (/\bpoetry\s+install\b/.test(cmds)) probes.push(".venv");
  if (/\buv\s+sync\b/.test(cmds)) probes.push(".venv");
  if (/\b(pip|pipenv)\b/.test(cmds)) probes.push(".venv");
  if (/\bbundle\s+install\b/.test(cmds)) probes.push("vendor/bundle");
  // Intentionally NOT probed:
  //   cargo fetch — writes to ~/.cargo/registry/cache, no worktree marker
  //   go mod download — writes to $GOPATH/pkg/mod, no worktree marker
  return probes;
}
