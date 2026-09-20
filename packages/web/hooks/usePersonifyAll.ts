import { useSyncExternalStore } from "react";
import { useInboxStore } from "../store/inboxStore";

/** The workspace's "give every session a character" switch. Kept out of
 *  lib/sessionIdentity so the resolver stays a pure module: a store import
 *  there made Vite serve it with no named `sessionIdentity` export. */
const noSubscription = () => () => {};

export function usePersonifyAll(override?: boolean): boolean {
  return useSyncExternalStore(
    override === undefined ? useInboxStore.subscribe : noSubscription,
    () => override ?? !!useInboxStore.getState().clientState?.ui?.personify_sessions,
    () => override ?? !!useInboxStore.getInitialState().clientState?.ui?.personify_sessions,
  );
}

/** The same switch, read once outside React — for ranking and matching, which
 *  run in callbacks rather than in a render. */
export function personifyAllNow(): boolean {
  return !!useInboxStore.getState().clientState?.ui?.personify_sessions;
}
