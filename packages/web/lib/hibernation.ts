import { HEARTBEAT_ALIVE_MS, isHibernated, sessionCommandOutcome } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { DispatchNotWiredError, isParkedDispatchError, isPermanentDispatchError } from "../store/mutativeMiddleware";

export function recordHibernationDispatchError(requestId: string, error: unknown) {
  if (isParkedDispatchError(error) || (!isPermanentDispatchError(error) && !(error instanceof DispatchNotWiredError))) return;
  const store = useInboxStore.getState();
  const row = store.sessionCommands[requestId];
  if (row && !row.executed_at) store.syncRecord("sessionCommands", requestId, { ...row, error: String(error), executed_at: Date.now() });
}

export function hibernationCandidate(row: any, viewerId: string | undefined, now: number): boolean {
  return !!viewerId && row.user_id === viewerId && !!row.owner_device_id && !!row.conversation_id &&
    !!row.session_id && ["idle", "done", "dormant"].includes(row.agent_status) &&
    !row.is_killed && !row.killed && !row.dismissed && !row.is_subagent &&
    !row.has_pending && !row.awaiting_input && !row.session_error && !row.pending_api_error &&
    now - row.last_heartbeat < HEARTBEAT_ALIVE_MS && row.awake_idle_ms >= 2 * 3600_000;
}

export function fleetBucket(row: any, now: number): "active" | "idle" | "dead" | "hibernated" {
  if (isHibernated(row)) return "hibernated";
  if (now - row.last_heartbeat >= HEARTBEAT_ALIVE_MS) return "dead";
  return row.awake_idle_ms >= 2 * 3600_000 ? "idle" : "active";
}

export function hibernationResultCounts(rows: any[]) {
  const counts = { pending: 0, succeeded: 0, skipped: 0, failed: 0 };
  for (const row of rows) counts[sessionCommandOutcome(row).state]++;
  return counts;
}
