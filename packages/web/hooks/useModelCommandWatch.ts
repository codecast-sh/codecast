import { useEffect } from "react";
import { useQuery } from "convex/react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../store/inboxStore";
import { SET_MODEL_CONFIRM_TIMEOUT_MS } from "../lib/modelSwitch";

/**
 * Watches store.pendingModelCommand for this conversation and reconciles the
 * optimistic model/effort stamp against the daemon's verdict: revert + notify
 * on refusal ("Session is busy…") or timeout (offline / pre-set_model daemon),
 * clear on confirmation. Mount it where the model badge lives — whichever
 * surface fired the switch, the open conversation supervises it. Shared by the
 * web conversation header and the mobile switcher chip.
 */
export function useModelCommandWatch(
  conversationId: string,
  notify: (message: string) => void,
): void {
  const pending = useInboxStore(useShallow((s) =>
    s.pendingModelCommand?.convId === conversationId ? s.pendingModelCommand : null,
  ));
  const result = useQuery(
    api.conversations.getDaemonCommandResult,
    pending ? { command_id: pending.commandId as Id<"daemon_commands"> } : "skip",
  );

  useEffect(() => {
    if (!pending) return;
    const store = useInboxStore.getState();
    if (result?.error) {
      store.setConversationModel(conversationId, pending.revert);
      notify(result.error);
      store.setPendingModelCommand(null);
      return;
    }
    if (result?.executed_at) {
      store.setPendingModelCommand(null);
      return;
    }
    const remaining = pending.startedAt + SET_MODEL_CONFIRM_TIMEOUT_MS - Date.now();
    const timer = setTimeout(() => {
      const cur = useInboxStore.getState().pendingModelCommand;
      if (cur?.commandId !== pending.commandId) return;
      useInboxStore.getState().setConversationModel(conversationId, pending.revert);
      notify("Model switch not confirmed — the daemon may be offline or outdated");
      useInboxStore.getState().setPendingModelCommand(null);
    }, Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [pending, result, conversationId, notify]);
}
