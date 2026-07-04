import {
  AGENT_MODEL_CONFIG,
  modelAgentKey,
} from "@codecast/shared/contracts";
import { useInboxStore, isConvexId } from "../store/inboxStore";

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

/** Stored model id → picker option key ("claude-opus-4-8" → "opus"). */
export function modelOptionKey(model: string | undefined | null, agentType: string | undefined): string {
  const cfg = AGENT_MODEL_CONFIG[modelAgentKey(agentType)];
  if (!model || !cfg) return "default";
  const bare = model.startsWith("claude-") ? model.slice("claude-".length) : model;
  const hit = cfg.models.find((m) => m.key !== "default" && (bare === m.key || bare.startsWith(`${m.key}-`)));
  return hit?.key ?? "default";
}

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
  if (!isConvexId(conversationId)) {
    notify("Session is still being created — try again in a moment");
    return;
  }
  const store = useInboxStore.getState();
  const agentKey = modelAgentKey(agentType);
  const prev = { model: current.model ?? null, effort: current.effort ?? null };
  store.setConversationModel(conversationId, {
    ...(sel.model !== undefined
      ? { model: sel.model === "default" ? null : (agentKey === "claude" ? `claude-${sel.model}` : sel.model) }
      : {}),
    ...(sel.effort !== undefined ? { effort: sel.effort === "default" ? null : sel.effort } : {}),
  });
  try {
    if (blank) {
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
