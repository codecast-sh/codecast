import type { ApprovalPolicy, SandboxMode, ThreadResumeParams, ThreadResumeResponse, Turn } from "./codexAppServer.js";

export type PersistedCodexThread = {
  threadId: string;
  updatedAt: number;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  activeTurnId?: string;
  recoveryAttempts?: number;
};

export const CODEX_RECOVERY_PROMPT = "Codecast restarted while your previous turn was still running. Continue the user's existing task from the saved conversation and current workspace. First check the results of any commands that may already have run; do not repeat completed actions. Respect any pending permission or user decision. Continue until the requested work is complete or you need the user's input.";
export const MAX_CODEX_RECOVERY_ATTEMPTS = 3;

/**
 * Params to bring a saved thread back. `fallbackSandbox` is the sandbox the
 * current config asks for, used only when the record predates sandbox
 * persistence. Resuming with no sandbox at all lets Codex 0.153+ substitute a
 * restrictive managed profile, which silently strips a running session of file
 * and network access, so callers that know the configured value must pass it.
 * It is never inferred from the record's own approval policy.
 */
export function codexResumeParams(
  record: PersistedCodexThread,
  approvalPolicy: ApprovalPolicy,
  fallbackSandbox?: SandboxMode,
): ThreadResumeParams {
  const sandbox = record.sandbox ?? fallbackSandbox;
  return {
    threadId: record.threadId,
    ...(record.cwd ? { cwd: record.cwd } : {}),
    approvalPolicy,
    ...(sandbox ? { sandbox } : {}),
  };
}

export function codexRecoveryAction(record: PersistedCodexThread, thread: ThreadResumeResponse["thread"]): "none" | "settled" | "active" | "continue" | "exhausted" {
  if (!record.activeTurnId) return "none";
  if (thread.status?.type === "active") return "active";
  const latest = thread.turns?.at(-1);
  if (!latest) throw new Error("Codex recovery could not inspect the last turn");
  if (latest.id !== record.activeTurnId || latest.status === "completed") return "settled";
  if (latest.status === "failed") return "settled";
  return (record.recoveryAttempts ?? 0) >= MAX_CODEX_RECOVERY_ATTEMPTS ? "exhausted" : "continue";
}

export function settledCodexRecord(record: PersistedCodexThread, turnId: string): PersistedCodexThread {
  return record.activeTurnId === turnId ? { ...record, activeTurnId: undefined, recoveryAttempts: undefined } : record;
}

export async function recoverCodexTurn(options: {
  record: PersistedCodexThread;
  thread: ThreadResumeResponse["thread"];
  save: (record: PersistedCodexThread) => void;
  start: (input: { threadId: string; input: Array<{ type: "text"; text: string }> }) => Promise<{ turn: Turn }>;
}): Promise<ReturnType<typeof codexRecoveryAction>> {
  const { record, thread, save, start } = options;
  const action = codexRecoveryAction(record, thread);
  if (action === "settled") save(settledCodexRecord(record, record.activeTurnId!));
  if (action === "continue") {
    save({ ...record, recoveryAttempts: (record.recoveryAttempts ?? 0) + 1 });
    await start({ threadId: record.threadId, input: [{ type: "text", text: CODEX_RECOVERY_PROMPT }] });
  }
  return action;
}
