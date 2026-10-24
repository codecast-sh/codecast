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
// A wait that ends without an answer (the bound, the agent moved on, the
// terminal answered) prints nothing, and the prompt is the terminal's again; a
// later web answer then falls back to pressing Enter/Escape in the pane.

/** How long a hook holds for a web answer. The terminal dialog works the whole
 *  time; past this the web answer is delivered as a keystroke instead. */
export const PERMISSION_HOOK_WAIT_MS = 10 * 60 * 1000;
/** Claude Code's timeout for the PermissionRequest entry: the wait plus room
 *  for the curl and the daemon's 204, so the hook is never killed mid-answer. */
export const PERMISSION_HOOK_TIMEOUT_S = PERMISSION_HOOK_WAIT_MS / 1000 + 20;

export interface PermissionHookInput {
  sessionId: string;
  toolName: string;
  preview: string;
  permissionMode?: string;
  suggestions: unknown[];
}

export interface PermissionAnswer {
  approved: boolean;
  /** A denial's reason, sent to the model. */
  message?: string;
  /** Keep Claude's suggested rules (updatedPermissions). */
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
    ...(typeof d.permission_mode === "string" && { permissionMode: d.permission_mode }),
    suggestions: Array.isArray(d.permission_suggestions)
      ? d.permission_suggestions.filter((s: unknown) => s && typeof s === "object")
      : [],
  };
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
/** A Write's whole file can ride in tool_input. */
export const PERMISSION_HOOK_MAX_BODY = 4 * 1024 * 1024;
