import { createContext, useContext, useSyncExternalStore } from "react";
import { useInboxStore } from "../store/inboxStore";

/** The workspace's "give every session a character" switch. Kept out of
 *  lib/sessionIdentity so the resolver stays a pure module: a store import
 *  there made Vite serve it with no named `sessionIdentity` export. */
const noSubscription = () => () => {};

/** Answers the switch for everything below it instead of the viewer's
 *  preference. The homepage hero sets it so its sessions render the same for
 *  every visitor. */
export const PersonifyOverride = createContext<boolean | undefined>(undefined);

export function usePersonifyAll(overrideProp?: boolean): boolean {
  const contextOverride = useContext(PersonifyOverride);
  const override = overrideProp ?? contextOverride;
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
