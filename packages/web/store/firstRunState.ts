// The inbox's first run, read off one store state: a signed-in person with no
// machine and no conversation, who is offered the hosted assistant or their
// own machine (EmptyState's onboarding variant). Pure and free of the store,
// so the store's create path reads it (createSessionFromStub) as well as the
// surfaces (lib/firstRun.ts).
import { cliNeverConnected } from "../lib/cliConnected";
import { isConvexId } from "../lib/entityLinks";
import { inboxFloorStamped } from "../hooks/syncMetaKeys";

export type FirstRun = "unknown" | "yes" | "no";

export type FirstRunState = {
  currentUser?: (Parameters<typeof cliNeverConnected>[0] & { _id?: { toString(): string } }) | null;
  sessions: Record<string, unknown>;
  pendingSessionCreates: Record<string, unknown>;
  syncMeta: Parameters<typeof inboxFloorStamped>[0]["syncMeta"];
};

/** "unknown" until the user doc has synced, and on a cold cache until the
 *  sessions floor has been cut: an empty cache there says nothing about
 *  whether the person has conversations. A composer's unsent stub (a local
 *  id with no create in flight) is not a conversation yet. */
export function firstRun(s: FirstRunState): FirstRun {
  if (s.currentUser == null) return "unknown";
  if (!cliNeverConnected(s.currentUser)) return "no";
  for (const id in s.sessions) if (isConvexId(id) || s.pendingSessionCreates[id]) return "no";
  return inboxFloorStamped(s, s.currentUser._id?.toString()) ? "yes" : "unknown";
}
