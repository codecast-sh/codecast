import { useRef } from "react";
import { useSyncDeliveryReceipts } from "./useSyncDeliveryReceipts";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import { installBrowserDispatchSelfHeal } from "./dispatchRecovery";
import { applyDispatchFailure, makeDispatchBinding, newDispatchAckState } from "../lib/dispatchBinding";

// Sync-log ack opt-in latch, shared by every mount for the page session: it
// flips false the first time the server rejects the ack_positions arg (see
// makeDispatchBinding).
const ackState = newDispatchAckState();

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
  useSyncDeliveryReceipts();
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
    _setDispatchError(applyDispatchFailure);
    // One binding per mount; it reads the latest mutation through the ref.
    const dispatch = makeDispatchBinding((args) => dispatchRef.current(args as any), ackState);
    const bindDispatch = () => {
      _setDispatch(dispatch, { owner: ownerRef.current });
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
