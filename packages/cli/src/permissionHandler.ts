import type { SyncService } from "./syncService.js";
import type { PermissionPrompt } from "./permissionDetector.js";

export interface PermissionDecision {
  approved: boolean;
}

const POLL_INTERVAL_MS = 1000;
const TIMEOUT_MS = 5 * 60 * 1000;

export async function handlePermissionRequest(
  syncService: SyncService,
  conversationId: string,
  sessionId: string,
  prompt: PermissionPrompt,
  log: (msg: string) => void
): Promise<PermissionDecision | null> {
  try {
    await syncService.createPermissionRequest({
      conversation_id: conversationId,
      session_id: sessionId,
      tool_name: prompt.tool_name,
      arguments_preview: prompt.arguments_preview,
    });

    log(`Created permission request for tool: ${prompt.tool_name}`);

    const startTime = Date.now();
    while (Date.now() - startTime < TIMEOUT_MS) {
      const decision = await syncService.getPermissionDecision(sessionId);

      if (decision) {
        const approved = decision.status === "approved";
        log(`Permission ${approved ? "approved" : "denied"} for tool: ${prompt.tool_name}`);
        return { approved };
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    log(`Permission request timed out for tool: ${prompt.tool_name}`);
    return null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error handling permission request: ${errMsg}`);
    return null;
  }
}
