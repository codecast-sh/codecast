import { createContext, useContext, useSyncExternalStore } from "react";
import { useInboxStore, type ClientUI } from "../store/inboxStore";
import { identityPrefsOf, type IdentityPrefs } from "../lib/sessionIdentity";

/** The viewer's identity preferences: whether roles wear characters, and
 *  whether every session gets one. Kept out of lib/sessionIdentity so the
 *  resolver stays a pure module: a store import there made Vite serve it with
 *  no named `sessionIdentity` export. */
const noSubscription = () => () => {};

/** Answers the preferences for everything below it instead of the viewer's.
 *  The homepage hero sets it so its sessions render the same for every
 *  visitor; a list sets it once so its rows need no subscription each. */
export const IdentityPrefsOverride = createContext<IdentityPrefs | undefined>(undefined);

const read = (ui: ClientUI | undefined) => identityPrefsOf(ui);

export function useIdentityPrefs(overrideProp?: IdentityPrefs): IdentityPrefs {
  const contextOverride = useContext(IdentityPrefsOverride);
  const override = overrideProp ?? contextOverride;
  return useSyncExternalStore(
    override === undefined ? useInboxStore.subscribe : noSubscription,
    () => override ?? read(useInboxStore.getState().clientState?.ui),
    () => override ?? read(useInboxStore.getInitialState().clientState?.ui),
  );
}

/** The same preferences, read once outside React — for ranking and matching,
 *  which run in callbacks rather than in a render. */
export function identityPrefsNow(): IdentityPrefs {
  return read(useInboxStore.getState().clientState?.ui);
}
