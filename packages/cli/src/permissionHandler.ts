import type { SyncService } from "./syncService.js";
import type { PermissionPrompt } from "./permissionDetector.js";
import type { RemovalPreview } from "./removalPreview.js";

export interface PermissionDecision {
  approved: boolean;
  /** A denial's reason from the web card. */
  message?: string;
  /** The approval keeps Claude's suggested rules. */
  remember?: boolean;
}

/** Where a prompt came from, shown on its card so a person can tell who is
 *  asking: a subagent (by type) rather than the session's own agent, and
 *  Claude Code's built-in safety check (the only thing that still asks in
 *  bypass mode, such as an rm whose target it cannot resolve). */
export interface PermissionSource {
  subagent_type?: string;
  /** That subagent's own conversation, where its steps up to the call are. */
  subagent_conversation_id?: string;
  safety_check?: boolean;
  /** The agent's one-line account of the call. */
  intent?: string;
  /** What each rm in the call would delete (removalPreview.ts). */
  removals?: RemovalPreview[];
}

const POLL_INTERVAL_MS = 1000;
// Long timeout: the global permission subscription (daemon.ts setupPermissionSubscription)
// is the authoritative injection path. This local poller exists only so call sites that
// await a decision can react. If the user takes longer than this, the row is cancelled
// so it stops cluttering the UI as a zombie pending — the subscription will then ignore it.
const TIMEOUT_MS = 60 * 60 * 1000;

export async function handlePermissionRequest(
  syncService: SyncService,
  conversationId: string,
  sessionId: string,
  prompt: PermissionPrompt & { suggestions?: unknown[]; source?: PermissionSource },
  log: (msg: string) => void,
  onCreated?: (permissionId: string) => void,
): Promise<PermissionDecision | null> {
  try {
    const permissionId = await syncService.createPermissionRequest({
      conversation_id: conversationId,
      session_id: sessionId,
      tool_name: prompt.tool_name,
      arguments_preview: prompt.arguments_preview,
      ...(prompt.suggestions?.length ? { suggestions: prompt.suggestions } : {}),
      ...prompt.source,
    });

    log(`Created permission request ${permissionId} for tool: ${prompt.tool_name}`);
    onCreated?.(permissionId);

    const startTime = Date.now();
    while (Date.now() - startTime < TIMEOUT_MS) {
      const decision = await syncService.getPermissionDecision(sessionId, permissionId);

      if (decision) {
        if (decision.status === "cancelled") {
          log(`Permission auto-cancelled (agent moved on) for tool: ${prompt.tool_name}`);
          return null;
        }
        const approved = decision.status === "approved";
        log(`Permission ${approved ? "approved" : "denied"} for tool: ${prompt.tool_name}`);
        return {
          approved,
          ...(decision.deny_message ? { message: decision.deny_message } : {}),
          ...(decision.remember ? { remember: true } : {}),
        };
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    log(`Permission request timed out for tool: ${prompt.tool_name}, cancelling row`);
    try {
      await syncService.cancelPermissionRequest(permissionId);
    } catch (cancelErr) {
      log(`Failed to cancel timed-out permission ${permissionId}: ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`);
    }
    return null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error handling permission request: ${errMsg}`);
    return null;
  }
}
