/**
 * spawnAgentTmux — the ONE primitive every daemon spawn site will eventually call
 * to launch an agent inside a tagged tmux session.
 *
 * Today the daemon has ~8 hand-rolled spawn sites (start_session, autoResume,
 * run_workflow, taskScheduler, …). Each re-derives the same four steps and they've
 * drifted: some shell-interpolate untrusted args, some skip path validation, some
 * forget to tag the session so the watchdog can't reclaim it. This module captures
 * the four invariants in one place so adopting it deletes a class of bugs:
 *
 *   (a) PATH SAFETY — the cwd must exist and be a directory. We REFUSE if it
 *       doesn't (mirrors the resume-refuse rule); we never $HOME-fallback, which
 *       would silently run the agent in the wrong place and mislabel the project.
 *   (b) NO SHELL INTERPOLATION — every tmux invocation goes through an arg-array
 *       runner (execFile, not a shell), and the command text is sent with
 *       `send-keys -l` (literal) so an arg like `"; rm -rf ~"` lands as inert text
 *       in the pane, never as a command the daemon's shell expands.
 *   (c) MANAGED-SESSION TAG — the new session is stamped with the same
 *       `@codecast_session_id` / `@codecast_agent_type` options the autoResume path
 *       sets, so a recovered tmux can always be matched back to its session and an
 *       orphan can't slip past reconciliation.
 *   (d) OWNERSHIP — claim the conversation through the injected device-routing
 *       helper before spawning. A remote box is never auto-owned (that decision
 *       lives server-side in pickOwnerDevice); on a remote we only spawn when this
 *       device already owns the work, so a broadcast can't double-spawn.
 *
 * Dependencies (the tmux runner, the ownership/registration calls, config and the
 * logger) are INJECTED, so the module is import-safe and unit-testable without a
 * live daemon or a real tmux server.
 */

import * as fs from "fs";
import * as path from "path";
import { tmuxExecSync as defaultTmuxExecSync } from "../tmux.js";
import type { Config } from "../config/types.js";
import type { AgentClientId } from "@codecast/shared/contracts";

/** Arg-array tmux runner. Mirrors tmux.ts `tmuxExecSync` — execFile, never a shell. */
export type TmuxRunner = (args: string[], opts?: { timeout?: number }) => string;

export interface SpawnAgentTmuxDeps {
  /** ~/.codecast/config.json (for agent flags etc.). */
  config: Config | null;
  /** Structured logger from the daemon; level optional. */
  log: (msg: string, level?: "debug" | "info" | "warn" | "error") => void;
  /**
   * Arg-array tmux runner. Defaults to the real execFile-based runner; injectable
   * so tests can assert on the exact tmux argv without a live server.
   */
  tmux?: TmuxRunner;
  /**
   * True when running on a remote box (the cloud Mac). A remote must never
   * auto-own/spawn — only the owning device spawns. Defaults to false.
   */
  isRemoteDevice?: boolean;
  /**
   * Claim ownership of the conversation before spawning. Returns whether this
   * device won. Wraps the server-side device router (pickOwnerDevice never
   * auto-owns a remote). Omit for ownership-less spawns (e.g. scheduled tasks
   * that have no conversation), in which case ownership is skipped.
   */
  claimOwnership?: (conversationId: string) => Promise<{ won: boolean; owner?: string }>;
  /**
   * Register the spawned tmux as a managed session so the UI lists it and the
   * watchdog can reconcile it. Best-effort; omit when there's no conversation.
   */
  registerManagedSession?: (
    sessionId: string,
    tmuxSession: string,
    conversationId: string,
  ) => Promise<unknown> | void;
}

export interface SpawnAgentTmuxRequest {
  /** Stable tmux session name. Validated to a safe charset before use. */
  tmuxSession: string;
  /** Working directory the agent runs in. MUST exist and be a directory. */
  cwd: string;
  /** Which agent — drives the `@codecast_agent_type` tag. */
  agentType: AgentClientId;
  /**
   * The exact command line to run in the pane. Sent literally via `send-keys -l`,
   * so it is never expanded by the daemon's own shell — quoting/escaping inside it
   * is the target pane shell's job (build it with arg arrays upstream).
   */
  command: string;
  /** Session id used for the managed-session tag + registration. */
  sessionId?: string;
  /** Conversation this spawn belongs to (drives ownership + registration). */
  conversationId?: string;
  /** Kill a same-named stale session first (default: true). */
  killExisting?: boolean;
}

export type SpawnAgentTmuxResult =
  | { ok: true; tmuxSession: string; cwd: string }
  | { ok: false; reason: string };

/** tmux session names: word-ish chars only (matches validateTmuxTarget in daemon). */
const SAFE_TMUX_NAME_RE = /^[a-zA-Z0-9_.:-]+$/;

/**
 * Validate a cwd the same way the daemon's start_session/resume paths do: it must
 * be an absolute path, resolve to itself, and actually exist as a DIRECTORY on
 * this machine. Returns the resolved path or null to REFUSE — callers must never
 * $HOME-fallback on a null.
 *
 * Only CONTROL characters are rejected: every downstream tmux call is an
 * arg-array execFile (no shell ever parses the path), so shell metacharacters
 * like ( ) ' & $ are inert here — and they occur in real directory names.
 * Rejecting them would refuse legitimate projects.
 */
export function validateSpawnCwd(p: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (!path.isAbsolute(p)) return null;
  if (/[\r\n\0]/.test(p)) return null;
  const resolved = path.resolve(p);
  if (resolved !== p && resolved !== p.replace(/\/+$/, "")) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  return resolved;
}

/**
 * Launch `command` for `agentType` inside a tagged tmux session at `cwd`.
 *
 * Refuses (returns `{ ok: false }`, never throws past validation) when the cwd is
 * missing/not-a-directory, the tmux name is unsafe, or another device owns the
 * conversation. On success the session is tagged and (when a conversation is
 * known) registered as a managed session.
 */
export async function spawnAgentTmux(
  req: SpawnAgentTmuxRequest,
  deps: SpawnAgentTmuxDeps,
): Promise<SpawnAgentTmuxResult> {
  const { config: _config, log } = deps;
  const tmux = deps.tmux ?? ((args, opts) => defaultTmuxExecSync(args, opts));

  if (!SAFE_TMUX_NAME_RE.test(req.tmuxSession)) {
    log(`[spawnAgentTmux] refusing unsafe tmux name: ${req.tmuxSession}`, "error");
    return { ok: false, reason: `unsafe tmux session name: ${req.tmuxSession}` };
  }

  // (a) Path safety — refuse rather than $HOME-fallback.
  const cwd = validateSpawnCwd(req.cwd);
  if (!cwd) {
    log(`[spawnAgentTmux] refusing spawn for ${req.tmuxSession}: cwd not a local directory: ${req.cwd}`, "error");
    return { ok: false, reason: `cwd does not exist or is not a directory: ${req.cwd}` };
  }

  // (d) Ownership — claim before spawning; a remote never auto-owns.
  if (req.conversationId && deps.claimOwnership) {
    if (deps.isRemoteDevice) {
      // A remote box must never auto-own. The server router (pickOwnerDevice)
      // already excludes remotes, so a remote that reaches here only spawns when
      // it already owns the work; claimOwnership is the authority on that.
      log(`[spawnAgentTmux] remote device claiming ${req.conversationId.slice(-12)} before spawn`, "debug");
    }
    let claim: { won: boolean; owner?: string };
    try {
      claim = await deps.claimOwnership(req.conversationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[spawnAgentTmux] ownership claim failed for ${req.conversationId.slice(-12)}: ${msg}`, "warn");
      return { ok: false, reason: `ownership claim failed: ${msg}` };
    }
    if (!claim.won) {
      log(`[spawnAgentTmux] ${req.conversationId.slice(-12)} owned by ${claim.owner?.slice(0, 8) ?? "another device"} — skipping spawn`);
      return { ok: false, reason: "conversation owned by another device" };
    }
  }

  // (b) No shell interpolation — arg arrays only; command sent literally.
  try {
    if (req.killExisting !== false) {
      try { tmux(["kill-session", "-t", req.tmuxSession]); } catch { /* none to kill */ }
    }
    tmux(["new-session", "-d", "-s", req.tmuxSession, "-c", cwd]);

    // (c) Managed-session tag — same options autoResumeSession sets, so a
    // recovered tmux is always matchable and orphans can't slip reconciliation.
    if (req.sessionId) {
      tmux(["set-option", "-q", "-t", req.tmuxSession, "@codecast_session_id", req.sessionId]);
    }
    tmux(["set-option", "-q", "-t", req.tmuxSession, "@codecast_agent_type", req.agentType]);

    // `-l` (literal): the command text is typed into the pane, never expanded by
    // the daemon's shell, so an injection attempt stays inert text.
    tmux(["send-keys", "-t", req.tmuxSession, "-l", req.command]);
    tmux(["send-keys", "-t", req.tmuxSession, "Enter"]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[spawnAgentTmux] failed to spawn ${req.tmuxSession}: ${msg}`, "error");
    return { ok: false, reason: `tmux spawn failed: ${msg}` };
  }

  // Register the managed session (best-effort).
  if (req.sessionId && req.conversationId && deps.registerManagedSession) {
    try {
      await deps.registerManagedSession(req.sessionId, req.tmuxSession, req.conversationId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[spawnAgentTmux] managed-session registration failed for ${req.tmuxSession}: ${msg}`, "warn");
    }
  }

  log(`[spawnAgentTmux] spawned ${req.agentType} in tmux=${req.tmuxSession} cwd=${cwd}`);
  return { ok: true, tmuxSession: req.tmuxSession, cwd };
}
