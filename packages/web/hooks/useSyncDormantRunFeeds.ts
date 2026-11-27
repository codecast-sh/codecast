// Feeder: the runs of sessions parked on a run the team feed does not carry
// (sessionFlowRuns.forTeam reads only the active team's runs). Without the run
// in the store, a session shipping in another workspace reads Working
// "running a flow" instead of its ship stage (lib/railActivity). One
// per-conversation feed (sessionFlowRuns.forConversation, a registered
// workflowRuns feed) for each such row, in a fixed number of slots so it is a
// hook useSyncCore mounts on web and the phone alike. Sync host only:
// followers receive the runs over replication.
import { useInboxStore } from "../store/inboxStore";
import { useIsSyncHost } from "./useSyncRole";
import { useSyncSessionFlowRuns } from "./useSyncWorkflows";
import { RUN_FEED_CAP, rowsNeedingRunFeed } from "../lib/railActivity";

export function useSyncDormantRunFeeds(): void {
  const host = useIsSyncHost();
  const ids = useInboxStore((s) => (host ? rowsNeedingRunFeed(s) : ""));
  const slots = ids ? ids.split(",") : [];
  // A constant slot count keeps the hook order stable; an empty slot skips its query.
  for (let i = 0; i < RUN_FEED_CAP; i++) useSyncSessionFlowRuns(slots[i] ?? null); // eslint-disable-line react-hooks/rules-of-hooks
}
