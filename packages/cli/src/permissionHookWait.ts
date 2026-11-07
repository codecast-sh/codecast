// Answering a Claude Code permission prompt with a decision instead of a key.
//
// Claude Code runs PermissionRequest hooks beside its own terminal dialog and
// takes whichever answers first (checked against 2.1.310's bundle). The status
// hook therefore posts the whole payload to the daemon's /hook/permission and
// waits there; the daemon creates the web card, and when the web answers, the
// hook prints a decision Claude reads directly:
//
//   {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
//     "decision":{"behavior":"allow","updatedPermissions":[...]}}}
//   {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
//     "decision":{"behavior":"deny","message":"...","interrupt":true}}}
//
// Before any of that, the daemon settles the call against codecast's own
// rules (permissionHandler.ts settlePermission): a saved approval or a
// configured deny answers at once, and so does a session nobody watches.
//
// A wait that ends without an answer (the bound, the agent moved on, the
// terminal answered) prints nothing, and the prompt is the terminal's again; a
// later web answer then falls back to pressing Enter/Escape in the pane.

/** How long a hook holds for a web answer. The terminal dialog works the whole
 *  time; past this the web answer is delivered as a keystroke instead. */
import * as fs from "node:fs";
import * as path from "node:path";
import { claudeToolRequest, type PermissionRuleRequest } from "@codecast/shared/contracts/permissionRules";

/** The checkout holding `dir`: the nearest directory with a `.git` (a
 *  worktree has a file there). A stat per level, on the hook's hot path. */
export function projectRootOf(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return undefined;
  }
}

export const PERMISSION_HOOK_WAIT_MS = 10 * 60 * 1000;
/** Claude Code's timeout for the PermissionRequest entry: the wait plus room
 *  for the curl and the daemon's 204, so the hook is never killed mid-answer. */
export const PERMISSION_HOOK_TIMEOUT_S = PERMISSION_HOOK_WAIT_MS / 1000 + 20;

export interface PermissionHookInput {
  sessionId: string;
  toolName: string;
  preview: string;
  /** The whole call as a push shows it (glanceCommand), read before the preview's cut. */
  glance: string;
  permissionMode?: string;
  /** The subagent that raised the prompt (its type, e.g. "Explore"); absent
   *  for the session's own agent. Claude Code sends agent_id only for subagents. */
  subagentType?: string;
  /** Claude Code's id for that subagent: its transcript is agent-<id>.jsonl. */
  agentId?: string;
  /** The agent's own one-line account of the call (a Bash call's description). */
  intent?: string;
  /** A Bash call's whole command and the directory it runs in, for the removal preview. */
  command?: string;
  cwd?: string;
  suggestions: unknown[];
  /** The call in codecast's rule terms: what it asks for and what "always" keeps. */
  ruleRequest: PermissionRuleRequest;
  /** The launch that raised the prompt, so the status it reports passes the launch fence. */
  launchToken?: string;
}

export interface PermissionAnswer {
  approved: boolean;
  /** A denial's reason, sent to the model. */
  message?: string;
  /** Keep the call's rules. Codecast keeps its own server side; Claude's
   *  suggestions ride back (updatedPermissions) only for a call codecast can
   *  keep nothing for (keptPatterns empty), as the card's button says. */
  remember?: boolean;
}

const PREVIEW_KEYS = ["command", "file_path", "pattern", "path", "url"] as const;
const PREVIEW_MAX = 300;

/** The PermissionRequest payload, or null when it is not one we can answer.
 *  The preview matches what codecast-status.sh builds for the status line. */
export function parsePermissionHookInput(body: string): PermissionHookInput | null {
  let d: any;
  try { d = JSON.parse(body); } catch { return null; }
  if (!d || typeof d !== "object" || d.hook_event_name !== "PermissionRequest") return null;
  const sessionId = typeof d.session_id === "string" ? d.session_id : "";
  const toolName = typeof d.tool_name === "string" ? d.tool_name : "";
  if (!sessionId || !toolName) return null;
  const input = d.tool_input && typeof d.tool_input === "object" ? d.tool_input : {};
  const first = PREVIEW_KEYS.map((k) => input[k]).find((v) => typeof v === "string" && v);
  return {
    sessionId,
    toolName,
    preview: (first ?? "").slice(0, PREVIEW_MAX),
    glance: glanceCommand(first ?? ""),
    ...(typeof d.permission_mode === "string" && { permissionMode: d.permission_mode }),
    ...(typeof input.description === "string" && input.description.trim() && { intent: input.description.trim().slice(0, 200) }),
    ...(typeof input.command === "string" && input.command && { command: input.command }),
    ...(typeof d.cwd === "string" && d.cwd && { cwd: d.cwd }),
    ...(typeof d.agent_id === "string" && d.agent_id && {
      subagentType: typeof d.agent_type === "string" && d.agent_type ? d.agent_type : "subagent",
      agentId: d.agent_id,
    }),
    suggestions: Array.isArray(d.permission_suggestions)
      ? d.permission_suggestions.filter((s: unknown) => s && typeof s === "object")
      : [],
    ruleRequest: claudeToolRequest(toolName, input, typeof d.cwd === "string" && d.cwd ? { cwd: d.cwd, root: projectRootOf(d.cwd) } : {}),
  };
}

/** A command as a person judges it from a push: without the leading
 *  `cd <dir> &&` (the push already names the session) and with each heredoc
 *  body folded to "…". A script body fills a short banner and pushes out what
 *  follows it, which is often the part Claude Code flagged. */
export function glanceCommand(command: string): string {
  const lines = command.replace(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/, "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const tag = lines[i].match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/)?.[2];
    if (!tag) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== tag) end++;
    out.push("…");
    i = end;
  }
  return out.join("\n");
}

/** The hook's stdout for an answer. A denial without a reason stops the turn,
 *  as Escape in the terminal does; one with a reason lets the model act on it. */
export function permissionDecisionOutput(answer: PermissionAnswer, suggestions: readonly unknown[]): string {
  const reason = answer.message?.trim();
  const decision = answer.approved
    ? { behavior: "allow", ...(answer.remember && suggestions.length > 0 && { updatedPermissions: suggestions }) }
    : reason
      ? { behavior: "deny", message: reason }
      : { behavior: "deny", message: "The user denied this from codecast.", interrupt: true };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

interface Waiter {
  sessionId: string;
  suggestions: unknown[];
  permissionId?: string;
  settle: (output: string | null) => void;
}

/** Hooks waiting on a web answer, matched by the permission row they created. */
export class PermissionHookWaiters {
  private waiters = new Set<Waiter>();

  /** Hold one hook. `done` resolves with its stdout, or null when the wait ends
   *  unanswered; it never rejects. */
  wait(sessionId: string, suggestions: unknown[], timeoutMs = PERMISSION_HOOK_WAIT_MS) {
    let resolve!: (output: string | null) => void;
    const done = new Promise<string | null>((r) => { resolve = r; });
    const waiter: Waiter = {
      sessionId,
      suggestions,
      settle: (output) => {
        if (!this.waiters.delete(waiter)) return;
        clearTimeout(timer);
        resolve(output);
      },
    };
    const timer = setTimeout(() => waiter.settle(null), timeoutMs);
    (timer as any).unref?.();
    this.waiters.add(waiter);
    return {
      done,
      bind: (permissionId: string) => { waiter.permissionId = permissionId; },
      cancel: () => waiter.settle(null),
    };
  }

  // Ids a hook answered. The subscription and the row's own poll both see one
  // answer; whichever comes second must not press a key into the pane too.
  private answered = new Set<string>();

  /** Answer the hook holding this permission. True when a hook holds it or
   *  already answered it; false means the caller falls back to a keystroke. */
  answer(permissionId: string, answer: PermissionAnswer): boolean {
    if (this.answered.has(permissionId)) return true;
    for (const w of this.waiters) {
      if (w.permissionId !== permissionId) continue;
      if (this.answered.size > 500) this.answered.clear();
      this.answered.add(permissionId);
      w.settle(permissionDecisionOutput(answer, w.suggestions));
      return true;
    }
    return false;
  }

  /** Is a hook waiting on this permission now? */
  holds(permissionId: string): boolean {
    for (const w of this.waiters) if (w.permissionId === permissionId) return true;
    return false;
  }

  /** The session left its prompt (answered in the terminal, or moved on). */
  releaseSession(sessionId: string): void {
    for (const w of [...this.waiters]) if (w.sessionId === sessionId) w.settle(null);
  }
}

/** The daemon's loopback route the hook waits on. */
export const PERMISSION_HOOK_PATH = "/hook/permission";
/** Carries the pane's launch token (the body is Claude Code's own payload). */
export const PERMISSION_LAUNCH_TOKEN_HEADER = "X-Codecast-Launch-Token";
/** A Write's whole file can ride in tool_input. */
export const PERMISSION_HOOK_MAX_BODY = 4 * 1024 * 1024;
