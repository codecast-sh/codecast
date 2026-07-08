import {
  AGENT_MODEL_CONFIG,
  modelAgentKey,
  modelOptionKey,
} from "@codecast/shared/contracts";
import { useInboxStore, isConvexId } from "../store/inboxStore";

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
//  - live session: set_model — the daemon drives the /model picker inside the
//    session's tmux and commits with `s` (session-only).
//
// Every initiator funnels through commitModelChange: optimistic local stamp →
// dispatch → record the command in store.pendingModelCommand. A mounted
// watcher (useModelCommandWatch) reconciles that command reactively and
// reverts + notifies if the daemon refuses ("Session is busy…") or never
// answers (offline / pre-set_model daemon). The durable confirmation is the
// transcript echo flowing back through the model/effort rollup — no
// server-side optimistic state anywhere.

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

// Maximum time we let an unanswered set_model keep its optimistic badge. An
// old daemon reports "Unknown command" as an error; an offline one never
// answers at all.
export const SET_MODEL_CONFIRM_TIMEOUT_MS = 25000;

/**
 * The one commit path for every surface. Optimistically stamps the local
 * store, dispatches the right command for the session state, and (live rail)
 * records the daemon command for the mounted watcher. `notify` surfaces
 * errors — sonner toast on web, the in-screen toast on mobile.
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

  // Blank session whose server row doesn't exist yet (the deferred compose stub,
  // or an in-flight optimistic create): the choice is purely a launch preference.
  // The local stamp above sticks to the stub row and createSessionFromStub folds
  // model/effort into the create — no server round-trip, no "not ready" error.
  // Mirrors how the agent switcher in the same row treats a stub id.
  if (blank && !isConvexId(conversationId)) return;

  // The live rail (set_model into a running tmux) genuinely needs a real id;
  // there's nothing to reconcile against a stub, so surface the wait.
  if (!isConvexId(conversationId)) {
    store.setConversationModel(conversationId, prev);
    notify("Session is still being created — try again in a moment");
    return;
  }

  try {
    if (blank) {
      // Already-created blank (pre-warmed real id): respawn with the new flags.
      await store.convCommand(conversationId, "reconfigureSession", sel);
    } else {
      const commandId = await store.convCommand(conversationId, "setSessionModel", sel);
      if (commandId) {
        store.setPendingModelCommand({
          convId: conversationId,
          commandId: commandId as string,
          revert: prev,
          startedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    store.setConversationModel(conversationId, prev);
    notify(err instanceof Error ? err.message : "Failed to switch model");
  }
}
