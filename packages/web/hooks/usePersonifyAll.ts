import { useInboxStore } from "../store/inboxStore";

/** The workspace's "give every session a character" switch. Kept out of
 *  lib/sessionIdentity so the resolver stays a pure module: a store import
 *  there made Vite serve it with no named `sessionIdentity` export. */
export function usePersonifyAll(): boolean {
  return useInboxStore((s) => !!s.clientState?.ui?.personify_sessions);
}
