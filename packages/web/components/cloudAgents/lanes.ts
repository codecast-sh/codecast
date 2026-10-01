// The lanes of a vendor's cloud agent (Codex: Codex Cloud on a ChatGPT plan,
// the Agents API on an API key): where the composer's lane pills start, and
// moving a message one lane refused (a private repository the Agents API
// cannot clone) to another.
import { cloudAgentLaunch, cloudAgentLaunchKey, cloudAgentProviderForLaunch, cloudAgentProvidersFor, modelOptionKey, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import { toast } from "sonner";
import { heldSendsOf } from "../../lib/pendingBanner";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { useInboxStore } from "../../store/inboxStore";

/**
 * The lane and model of the newest session launched on a cloud agent of this
 * agent type (of one provider, when given), as its launch key: the
 * composer's switch and lane pills start where the person last ran. Read at
 * the click from the store's sessions, each of which keeps its launch key as
 * its model; null when there is none. With `usable` (whether the machine can
 * drive a lane now), a lane it can't is passed over for one it can: the
 * newest launch there, else that lane's default.
 */
export function lastCloudLaunch(agentType: string, spec?: CloudAgentProviderSpec, usable?: (lane: CloudAgentProviderSpec) => boolean): string | null {
  type Launch = { at: number; key: string; lane: CloudAgentProviderSpec };
  let newest: Launch | null = null;
  let newestUsable: Launch | null = null;
  for (const row of Object.values(useInboxStore.getState().sessions)) {
    if (row.agent_type !== agentType || !row.model) continue;
    const key = modelOptionKey(row.model, agentType);
    const lane = cloudAgentProviderForLaunch(agentType, key);
    if (!lane || (spec && lane.id !== spec.id)) continue;
    const at = row.started_at ?? 0;
    const launch = { at, lane, key: cloudAgentLaunchKey(lane, { model: cloudAgentLaunch(agentType, key)?.model ?? "" }) };
    if (!newest || at > newest.at) newest = launch;
    if (usable?.(lane) && (!newestUsable || at > newestUsable.at)) newestUsable = launch;
  }
  if (!usable || (newest && usable(newest.lane))) return newest?.key ?? null;
  // The machine can't drive the lane last run on (or none was run): the newest launch on one it can, else that lane's default.
  const other = newestUsable?.key ?? cloudAgentProvidersFor(agentType).find((l) => l.lane && (!spec || l.id === spec.id) && usable(l))?.modelPrefix;
  return other ?? newest?.key ?? null;
}

/**
 * Start what a session holds on another lane instead: its held messages are
 * cancelled first, and the ones the cancel took back (not ones the session got
 * in the meantime) become the first message of a new session in the same
 * folder, from the same machine, on `lane` (its last launch, else its
 * default). The session it started from stays as it is, and the view moves to
 * the new one. A message is never in both: one the cancel could not take back
 * stays where it is, and a toast says so. Resolves false when nothing moved.
 */
export async function moveHeldToLane(conversationId: string, lane: CloudAgentProviderSpec): Promise<boolean> {
  const store = useInboxStore.getState();
  const held = heldSendsOf(store, conversationId);
  if (!held.length) return false;
  const outcomes = await Promise.allSettled(held.map((m) => store.cancelPendingMessage(conversationId, { messageId: m.message_id, clientId: m.client_id })));
  const moved = held.filter((_, i) => { const o = outcomes[i]; return o.status === "fulfilled" && o.value === "cancelled"; });
  const stayed = held.length - moved.length;
  if (stayed) {
    const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
    toast.error(`${stayed === 1 ? "A message" : `${stayed} messages`} stayed in this session${failed ? `: ${failed.reason instanceof Error ? failed.reason.message : String(failed.reason)}` : ", which got it before the move"}.`);
  }
  if (!moved.length) return false;
  const meta = (store.conversations[conversationId] ?? store.sessions[conversationId]) as { project_path?: string; owner_device_id?: string } | undefined;
  const { stubId } = spawnSessionWithPrompt({
    prompt: moved.map((m) => m.content).join("\n\n"),
    agentType: lane.agentType,
    projectPath: meta?.project_path,
    model: lastCloudLaunch(lane.agentType, lane) ?? lane.modelPrefix,
    targetDeviceId: meta?.owner_device_id,
    failureLabel: `Failed to start on ${lane.label}`,
  });
  store.requestNavigate(stubId, { source: "gesture" });
  return true;
}
