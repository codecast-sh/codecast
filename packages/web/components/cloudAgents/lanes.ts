// The lanes of a vendor's cloud agent (Codex: Codex Cloud on a ChatGPT plan,
// the Agents API on an API key): where the composer's lane pills start, and
// moving a message one lane refused (a private repository the Agents API
// cannot clone) to another.
import { cloudAgentLaunch, cloudAgentLaunchKey, cloudAgentProviderForLaunch, modelOptionKey, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { serverPendingRows, type ServerPendingRow, type ServerPendingStatus } from "../../lib/pendingBanner";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { useInboxStore } from "../../store/inboxStore";

/**
 * The lane and model of the newest session launched on a cloud agent of this
 * agent type (of one provider, when given), as its launch key: the
 * composer's switch and lane pills start where the person last ran. Read at
 * the click from the store's sessions, each of which keeps its launch key as
 * its model; null when there is none.
 */
export function lastCloudLaunch(agentType: string, spec?: CloudAgentProviderSpec): string | null {
  let newest: { at: number; key: string } | null = null;
  for (const row of Object.values(useInboxStore.getState().sessions)) {
    if (row.agent_type !== agentType || !row.model) continue;
    const key = modelOptionKey(row.model, agentType);
    const lane = cloudAgentProviderForLaunch(agentType, key);
    if (!lane || (spec && lane.id !== spec.id)) continue;
    const at = row.started_at ?? 0;
    if (!newest || at > newest.at) newest = { at, key: cloudAgentLaunchKey(lane, { model: cloudAgentLaunch(agentType, key)?.model ?? "" }) };
  }
  return newest?.key ?? null;
}

/** The messages a session holds that have not reached it, from its server pending rows (whichever window sent them), oldest first. */
export function heldSends(pending: ServerPendingStatus | null | undefined): ServerPendingRow[] {
  return serverPendingRows(pending).filter((r) => r.status === "pending" && !!r.content);
}

/**
 * Start what a session holds on another lane instead: a new session in the
 * same folder, from the same machine, on `lane` (its last launch, else its
 * default), gets the held messages as its first; this session's hold is
 * cancelled. The session it started from stays as it is, and the view moves
 * to the new one. False when nothing is held.
 */
export function moveHeldToLane(conversationId: string, lane: CloudAgentProviderSpec): boolean {
  const store = useInboxStore.getState();
  const held = heldSends(store.pendingMessageStatus?.[conversationId] as ServerPendingStatus | undefined);
  if (!held.length) return false;
  const meta = (store.conversations[conversationId] ?? store.sessions[conversationId]) as { project_path?: string; owner_device_id?: string } | undefined;
  const { stubId } = spawnSessionWithPrompt({
    prompt: held.map((m) => m.content).join("\n\n"),
    agentType: lane.agentType,
    projectPath: meta?.project_path,
    model: lastCloudLaunch(lane.agentType, lane) ?? lane.modelPrefix,
    targetDeviceId: meta?.owner_device_id,
    failureLabel: `Failed to start on ${lane.label}`,
  });
  for (const m of held) void store.cancelPendingMessage(conversationId, { messageId: m.message_id, clientId: m.client_id }).catch(() => {});
  store.requestNavigate(stubId, { source: "gesture" });
  return true;
}
