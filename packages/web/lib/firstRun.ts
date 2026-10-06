// The inbox's first run: a signed-in person with no machine and no
// conversation, who is offered the hosted assistant or their own machine
// (EmptyState's onboarding variant). One reading of it for the three places
// that care: the inbox shows the card on "yes", and the dialogs that open
// unasked (device setup, the inbox tour) stay out of the way until "no".
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { writeLane } from "../components/simple/lanePref";
import { inboxFloorStamped } from "../hooks/useSyncInboxSessions";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { cliNeverConnected } from "./cliConnected";

export type FirstRun = "unknown" | "yes" | "no";

type FirstRunState = {
  currentUser?: Parameters<typeof cliNeverConnected>[0] & { _id?: { toString(): string } };
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

export const useFirstRun = (): FirstRun => useInboxStore(firstRun);

/** Someone whose first conversation, with no machine, goes to the hosted
 *  assistant is in hosted mode from then on, as /welcome leaves them. Called
 *  as that conversation is created, before its create is in flight. */
export function joinHostedOnFirstRun(agentType: string | undefined): void {
  if (agentType === HOSTED_AGENT_TYPE && firstRun(useInboxStore.getState()) === "yes") writeLane("simple");
}
