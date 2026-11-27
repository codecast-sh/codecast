// Feeder: the runs of sessions parked on a run the team feed does not carry
// (sessionFlowRuns.forTeam reads only the active team's runs). Without the run
// in the store, a session shipping in another workspace reads Working
// "running a flow" in the rail instead of its ship stage (lib/railActivity).
// One per-conversation feed (sessionFlowRuns.forConversation, a registered
// workflowRuns feed) for each such row: a handful at most. Mounted on the
// sync host only; followers receive the runs over replication.
import { useInboxStore } from "../../store/inboxStore";
import { useSyncSessionFlowRuns } from "../../hooks/useSyncWorkflows";
import { rowsNeedingRunFeed } from "../../lib/railActivity";

export function DormantRunFeeds() {
  const ids = useInboxStore((s) => rowsNeedingRunFeed(s));
  return <>{ids ? ids.split(",").map((id) => <RunFeed key={id} conversationId={id} />) : null}</>;
}

function RunFeed({ conversationId }: { conversationId: string }) {
  useSyncSessionFlowRuns(conversationId);
  return null;
}
