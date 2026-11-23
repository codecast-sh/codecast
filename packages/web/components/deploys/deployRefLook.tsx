// The part of a deploy pill that ticks: the words after a deploy's name
// (lib/deploys/deployPill). A pull request's or commit's state after its name
// is its change's track and word (components/changes/RefChangeSegment).
import { useNowWhen } from "../../hooks/useCoarseNow";
import { deployPillSuffix } from "../../lib/deploys/deployPill";

/** The words after a deploy's name in its pill. One still waiting or deploying ticks once a minute; no animation. */
export function DeployPillSuffix({ deploy }: { deploy: any }) {
  const ticks = deploy.status === "running" || deploy.status === "requested";
  const now = useNowWhen((t) => (ticks ? deployPillSuffix(deploy, t) : ""), 15_000);
  return <span className="self-baseline whitespace-nowrap">· {deployPillSuffix(deploy, now)}</span>;
}
