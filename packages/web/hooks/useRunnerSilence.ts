import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { DEVICE_ONLINE_MS } from "@codecast/convex/convex/deviceRouting";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useCoarseNow } from "./useCoarseNow";
import { formatDuration } from "./useDaemonHealth";

const api = _typedApi as any;

/**
 * The machine a session runs on, when it has stopped beating: its name and
 * how long it has been silent, worded for a status line ("jb-m5-max, offline
 * 5 days"). Null while it beats, while the answer is unknown, or when
 * disabled. Liveness is judged on this client's clock, because a machine
 * that stopped writes nothing that would re-run the query. Messages sent to
 * a silent machine wait for it, so a surface that would otherwise call the
 * session live or "Processing..." says this instead.
 */
export function useRunnerSilence(conversationId: string, enabled: boolean): string | null {
  const runner = useQueryNoThrow(api.devices.getConversationMachine, enabled ? { conversation_id: conversationId } : "skip").data;
  const now = useCoarseNow(enabled ? 60_000 : 3_600_000);
  if (!enabled || runner?.last_seen == null) return null;
  const silentMs = now - runner.last_seen;
  return silentMs >= DEVICE_ONLINE_MS ? `${deviceDisplayName(runner)}, offline ${formatDuration(silentMs)}` : null;
}
