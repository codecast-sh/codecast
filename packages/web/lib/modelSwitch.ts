import {
  AGENT_MODEL_CONFIG,
  findModelOption,
  modelAgentKey,
  modelOptionKey,
} from "@codecast/shared/contracts";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { DispatchNotWiredError } from "../store/mutativeMiddleware";

// modelOptionKey ("claude-opus-4-8" → "opus") is pure contract logic — it lives
// in @codecast/shared/contracts now (the store's create path needs it too). Kept
// re-exported here so existing importers (the pickers, the mobile chip) are
// unaffected.
export { modelOptionKey };

// UI-free model/effort switching logic, shared by the web pickers
// (components/ModelEffortPicker.tsx) and the mobile app's switcher sheet.
// Two rails, picked by session state:
//  - blank session (message_count === 0): reconfigureSession — idempotent
//    respawn with --model/--effort launch flags.
//  - live session: the agent's own `/model <alias>` / `/effort <level>`
//    commands, sent as ORDINARY MESSAGES. They ride the same optimistic bubble
//    + outbox rail as anything typed into the composer, so the switch is
//    local-first, survives a reload, queues while offline, and revives a dead
//    session (the daemon's delivery path auto-resumes before it injects). The
//    durable confirmation is the transcript echo ("Set model to …") flowing
//    back through the model/effort rollup — no server-side optimistic state.

export function effortGlyph(effort: string | undefined | null): string {
  switch (effort) {
    case "low": return "○";
    case "medium": return "◐";
    case "high": return "●";
    case "max": case "xhigh": return "◈";
    default: return "";
  }
}

/** True when this agent/session-state combination has a working rail. */
export function canControlModel(agentType: string | undefined, blank: boolean): boolean {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  return !!cfg && (blank || cfg.midSession);
}

/**
 * The in-session commands that apply a model/effort selection to a running
 * agent, one message each. "default" for the model means the agent's own saved
 * default (`/model default`); an unknown key yields nothing.
 */
export function modelSwitchMessages(
  agentType: string | undefined,
  sel: { model?: string; effort?: string },
): string[] {
  const out: string[] = [];
  if (sel.model !== undefined) {
    const alias = sel.model === "default" ? "default" : findModelOption(agentType, sel.model)?.cliAlias;
    if (alias) out.push(`/model ${alias}`);
  }
  if (sel.effort !== undefined) out.push(`/effort ${sel.effort}`);
  return out;
}

/**
 * The one commit path for every surface. Optimistically stamps the local
 * store, then either respawns a blank session with launch flags or sends the
 * switch commands as messages to a live one. `notify` surfaces errors — sonner
 * toast on web, the in-screen toast on mobile.
 */
export async function commitModelChange(opts: {
  conversationId: string;
  agentType: string | undefined;
  current: { model?: string | null; effort?: string | null };
  sel: { model?: string; effort?: string };
  blank: boolean;
  notify: (message: string) => void;
}): Promise<void> {
  const { conversationId, agentType, current, sel, blank, notify } = opts;
  const store = useInboxStore.getState();
  const agentKey = modelAgentKey(agentType);
  const prev = { model: current.model ?? null, effort: current.effort ?? null };

  // Optimistic local stamp — the durable confirmation is the transcript echo
  // (live rail) or, for a blank session, the model/effort the create launches
  // with. Runs first so the picker reflects the choice instantly on every rail,
  // including a not-yet-created stub.
  store.setConversationModel(conversationId, {
    ...(sel.model !== undefined
      ? { model: sel.model === "default" ? null : (agentKey === "claude" ? `claude-${sel.model}` : sel.model) }
      : {}),
    ...(sel.effort !== undefined ? { effort: sel.effort === "default" ? null : sel.effort } : {}),
  });

  if (!blank) {
    // Live rail: the switch IS a message. addOptimisticMessage + sendMessage is
    // the standard composer pair (the same two-step the decision queue and the
    // blocked-session "continue" use), so delivery, retry and failure honesty
    // are all inherited from the outbox — including on a stub id, which the
    // pending-message rekey carries over to the real conversation.
    const messages = modelSwitchMessages(agentType, sel);
    if (messages.length === 0) {
      store.setConversationModel(conversationId, prev);
      notify("This model can't be switched in a running session");
      return;
    }
    for (const content of messages) {
      const clientId = store.addOptimisticMessage(conversationId, content);
      store.sendMessage(conversationId, content, undefined, clientId);
    }
    return;
  }

  // Blank session whose server row doesn't exist yet (the deferred compose stub,
  // or an in-flight optimistic create): the choice is purely a launch preference.
  // The local stamp above sticks to the stub row and createSessionFromStub folds
  // model/effort into the create — no server round-trip, no "not ready" error.
  // Mirrors how the agent switcher in the same row treats a stub id.
  if (!isConvexId(conversationId)) return;

  try {
    // Already-created blank (pre-warmed real id): respawn with the new flags.
    await store.convCommand(conversationId, "reconfigureSession", sel);
  } catch (err) {
    // Parked-unwired means the write is queued and WILL apply on the next
    // outbox drain — reverting the local stamp here would make the UI disagree
    // with the server the moment it lands. Keep the choice; stay quiet.
    if (err instanceof DispatchNotWiredError && err.parked) return;
    store.setConversationModel(conversationId, prev);
    notify(err instanceof Error ? err.message : "Failed to switch model");
  }
}
