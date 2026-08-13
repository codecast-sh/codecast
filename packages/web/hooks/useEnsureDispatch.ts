import { useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { isPermanentDispatchError } from "../store/mutativeMiddleware";
import { useWatchEffect } from "./useWatchEffect";
import { installBrowserDispatchSelfHeal } from "./dispatchRecovery";

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
      result[key] = deepMerge(tv, sv);
    } else {
      result[key] = sv;
    }
  }
  return result;
}

// Wires the store's server dispatch (store.sendMessage etc. route through this).
// _setDispatch / _setDispatchError just set module-level refs, so calling this
// from multiple mounted components is harmless and idempotent. Split out from
// useSyncInboxSessions so a screen can guarantee dispatch is wired (e.g. a cold
// deep-link into a session before the inbox tab has mounted) WITHOUT also
// spinning up the inbox subscriptions/recovery polling/soundIdle that hook owns.
export function useEnsureDispatch() {
  const _setDispatch = useInboxStore((s) => s._setDispatch);
  const _clearDispatch = useInboxStore((s) => s._clearDispatch);
  const _setDispatchError = useInboxStore((s) => s._setDispatchError);
  const dispatchMutation = useMutation(api.dispatch.dispatch).withOptimisticUpdate(
    (localStore, { patches }) => {
      if (!patches?.client_state) return;
      const current = localStore.getQuery(api.client_state.get, {});
      if (!current) return;
      const updates = (patches.client_state as any)._;
      if (!updates) return;
      localStore.setQuery(api.client_state.get, {}, deepMerge(current, updates));
    }
  );

  const dispatchRef = useRef(dispatchMutation);
  const ownerRef = useRef<object>({});
  dispatchRef.current = dispatchMutation;

  useWatchEffect(() => {
    _setDispatchError((action, error, args) => {
      console.error(`[sync] dispatch failed after retries: ${action}`, error);
      // COMMAND_ID_REUSED on a send means the server already holds a receipt
      // for this client id — the message was delivered; only a redrive that
      // rebuilt the payload with different bytes (e.g. a pending row persisted
      // before mention expansion was recorded) got refused. Surfacing it would
      // toast "didn't go through" and mark a delivered bubble as failed.
      if (action === "sendMessage" && /COMMAND_ID_REUSED/.test(String((error as Error)?.message ?? error))) {
        return;
      }
      useInboxStore.setState(s => ({ dispatchErrors: s.dispatchErrors + 1 }));
      // A permanent rejection is dropped from the outbox (no re-drive will
      // land it), so it's the user's only chance to hear their action didn't
      // take — record it for the platform's feedback surface to render.
      if (isPermanentDispatchError(error)) {
        useInboxStore.setState({
          lastDispatchFailure: { action, args, message: String((error as Error)?.message ?? error), at: Date.now() },
        });
      }
      if (action === "sendMessage" && Array.isArray(args)) {
        // Args mirror dispatch.sendMessage: [conversation_id, content, image_ids, client_id].
        const [convId, , , clientId] = args as [string?, unknown?, unknown?, string?];
        // The optimistic bubble is the only copy of the user's text once the
        // server rejects the send (nothing was written). Mark it failed so the
        // reconcile prune keeps it and the thread shows "Failed to send"
        // instead of silently dropping what the user typed.
        if (typeof convId === "string" && typeof clientId === "string") {
          useInboxStore.getState().markOptimisticAsFailed(convId, clientId);
        }
        // A send into a conversation whose server row was deleted (cached ghost).
        // Flag it so the view can offer "restore" instead of failing silently.
        if (typeof convId === "string" && /conversation_deleted/.test(String(error))) {
          useInboxStore.getState().markServerDeleted(convId);
        }
      }
      // The same rule for a chat send, through the same one mechanism. Args
      // mirror dispatchChatSend: [channel_id, content, client_id, opts]. The
      // optimistic row is the only copy of what was typed, so mark it failed —
      // the message then renders with its retry affordance instead of sitting
      // there looking sent. A retry re-dispatches the SAME client id, which
      // chat.sendMessage dedupes, so this can never double-post.
      if (action === "dispatchChatSend" && Array.isArray(args)) {
        const clientId = args[2];
        if (typeof clientId === "string") {
          useInboxStore.getState().markChatSendFailed(
            clientId,
            String((error as Error)?.message ?? error),
          );
        }
      }
    });
    const bindDispatch = () => {
      _setDispatch(
        (action, args, patches, result) => dispatchRef.current({ action, args, patches, result }),
        { owner: ownerRef.current },
      );
      return true;
    };
    // Re-drive any parked dispatch when the client likely has connectivity
    // again. The boot drain only fires once on load, so a send the live socket
    // stranded (in-session retries exhausted with no reload in sight) would sit
    // undelivered indefinitely. Coming back online, refocusing the tab, and a
    // slow heartbeat each give it a fresh chance to land — no reload required.
    // `window` exists in React Native but has no browser event APIs (and there's
    // no `document`), so an SSR-style `typeof window === "undefined"` check passes
    // and then crashes on `window.addEventListener`. Require the real APIs.
    const getDispatchRecoveryStore = () => {
      const store = useInboxStore.getState() as unknown as {
        _drainOutbox: () => void;
        _isDispatchWired: () => boolean;
      };
      return store;
    };
    // _drainOutbox / _isDispatchWired are injected onto the store by
    // mutativeMiddleware (siblings of _setDispatch). These browser signals are
    // the recovery path for socket/connectivity stalls.
    return installBrowserDispatchSelfHeal({
      bindDispatch,
      isDispatchWired: () => getDispatchRecoveryStore()._isDispatchWired(),
      drainOutbox: () => getDispatchRecoveryStore()._drainOutbox(),
      clearDispatch: () => _clearDispatch(ownerRef.current),
      browserWindow:
        typeof window !== "undefined" && typeof window.addEventListener === "function"
          ? window
          : null,
      browserDocument: typeof document !== "undefined" ? document : null,
    });
  }, [_setDispatch, _clearDispatch, _setDispatchError]);
}
