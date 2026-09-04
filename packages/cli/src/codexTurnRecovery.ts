import { sandboxResumeParams, type ApprovalPolicy, type SandboxMode, type SandboxPolicy, type ThreadResumeParams, type ThreadResumeResponse, type Turn } from "./codexAppServer.js";

export type PersistedCodexThread = {
  threadId: string;
  updatedAt: number;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  /** The policy the server reported for this thread, recorded so a restart can
   *  reproduce it exactly. Preferred over `sandbox`, which is a coarse mode and
   *  cannot carry workspace roots or network access. */
  sandboxPolicy?: SandboxPolicy;
  activeTurnId?: string;
  recoveryAttempts?: number;
};

/**
 * What to write to disk as a thread's policy. This is the production decision,
 * shared by every persist site in the daemon.
 *
 * While an override is in flight the answer is `undefined`, never the previous
 * value. The previous value is the BROADER one, so reusing it would let a crash
 * or a lost response restore access the thread may no longer have. A record with
 * no policy resumes with no sandbox, which is restrictive: the safe direction.
 */
export function persistedPolicyFor(input: {
  pending: boolean;
  invalidated?: boolean;
  live?: SandboxPolicy;
  previous?: SandboxPolicy;
}): SandboxPolicy | undefined {
  if (input.pending || input.invalidated) return undefined;
  return input.live ?? input.previous;
}

/**
 * Updates ONLY the policy on an existing record, in place.
 *
 * A policy refresh is not a lifecycle event: it must not replace the record,
 * because the rehydrate loop captures a record and re-checks it by identity to
 * detect that another path replaced the conversation's work. Replacing the
 * object here would make our own refresh indistinguishable from a real
 * replacement, and a genuine one can keep the same threadId while changing
 * activeTurnId, recoveryAttempts, cwd or approval intent.
 *
 * Returns false when there is no matching record to update, which is not a
 * failure: nothing stored is granting this thread the old policy.
 */
export function applyPolicyInPlace(
  record: PersistedCodexThread | undefined,
  threadId: string,
  policy: SandboxPolicy | undefined,
): boolean {
  if (!record || record.threadId !== threadId) return false;
  record.sandboxPolicy = policy;
  return true;
}

/**
 * Wires policy persistence to the client's lifecycle events. Both events mean
 * "this thread's stored policy is now stale", one because the outcome is unknown
 * and one because it is newly known, so both persist the same way.
 */
export function registerPolicyPersistenceHandlers(input: {
  client: { on(event: string, listener: (threadId: string) => void): unknown };
  conversationForThread: (threadId: string) => string | undefined;
  /** Returns false when the record could not be written. */
  persist: (conversationId: string, threadId: string) => boolean;
}): void {
  // Invalidation is a BARRIER: it runs before a request that may change the
  // policy, and throwing here stops that request from reaching the socket. A
  // narrowing must never be in flight while the stored record still grants the
  // old broader access, and a swallowed write error is exactly that state.
  input.client.on("policyInvalidated", (threadId) => {
    const conversationId = input.conversationForThread(threadId);
    if (conversationId === undefined) return;
    if (!input.persist(conversationId, threadId)) {
      throw new Error(`could not persist the cleared policy for conversation ${conversationId}`);
    }
  });
  // Confirmation is best effort. A failure here leaves the record with no
  // policy, which resumes restricted: the safe direction, and not worth
  // failing a turn that the server already accepted.
  input.client.on("policyConfirmed", (threadId) => {
    const conversationId = input.conversationForThread(threadId);
    if (conversationId !== undefined) input.persist(conversationId, threadId);
  });
}

export const CODEX_RECOVERY_PROMPT = "Codecast restarted while your previous turn was still running. Continue the user's existing task from the saved conversation and current workspace. First check the results of any commands that may already have run; do not repeat completed actions. Respect any pending permission or user decision. Continue until the requested work is complete or you need the user's input.";
export const MAX_CODEX_RECOVERY_ATTEMPTS = 3;

/**
 * Params to bring a saved thread back, reproducing the policy it actually ran
 * under. A recorded `sandboxPolicy` is authoritative and restores writable roots
 * and network access; a legacy record carrying only the coarse `sandbox` mode
 * replays that mode, which is the most the protocol can express for it.
 *
 * A record with NEITHER sends no sandbox at all. That is deliberate: an unknown
 * prior sandbox stays unspecified rather than guessed, because naming a mode we
 * cannot justify would widen a thread that was deliberately restricted. The cost
 * is that such a thread resumes under whatever Codex resolves, which is
 * restrictive; losing access is recoverable, granting it silently is not.
 */
export function codexResumeParams(
  record: PersistedCodexThread,
  approvalPolicy: ApprovalPolicy,
): ThreadResumeParams {
  const fromPolicy = sandboxResumeParams(record.sandboxPolicy);
  const sandbox = fromPolicy.sandbox ?? record.sandbox;
  return {
    threadId: record.threadId,
    ...(record.cwd ? { cwd: record.cwd } : {}),
    approvalPolicy,
    ...(sandbox ? { sandbox } : {}),
    ...(fromPolicy.config ? { config: fromPolicy.config } : {}),
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
