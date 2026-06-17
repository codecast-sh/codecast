import { useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "./useMountEffect";

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
  dispatchRef.current = dispatchMutation;

  useMountEffect(() => {
    _setDispatch((action, args, patches, result) => dispatchRef.current({ action, args, patches, result }));
    _setDispatchError((action, error, args) => {
      console.error(`[sync] dispatch failed after retries: ${action}`, error);
      useInboxStore.setState(s => ({ dispatchErrors: s.dispatchErrors + 1 }));
      // A send into a conversation whose server row was deleted (cached ghost).
      // Flag it so the view can offer "restore" instead of failing silently.
      if (action === "sendMessage" && /conversation_deleted/.test(String(error))) {
        const convId = Array.isArray(args) ? args[0] : undefined;
        if (typeof convId === "string") useInboxStore.getState().markServerDeleted(convId);
      }
    });

    // Re-drive any parked dispatch when the client likely has connectivity
    // again. The boot drain only fires once on load, so a send the live socket
    // stranded (in-session retries exhausted with no reload in sight) would sit
    // undelivered indefinitely. Coming back online, refocusing the tab, and a
    // slow heartbeat each give it a fresh chance to land — no reload required.
    if (typeof window === "undefined") return;
    // _drainOutbox is injected onto the store by mutativeMiddleware (a sibling
    // of _setDispatch); typed at the call site so the wiring lives entirely here.
    const drain = () => (useInboxStore.getState() as unknown as { _drainOutbox: () => void })._drainOutbox();
    const onVisible = () => { if (document.visibilityState === "visible") drain(); };
    window.addEventListener("online", drain);
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(drain, 30_000);
    return () => {
      window.removeEventListener("online", drain);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  });
}
