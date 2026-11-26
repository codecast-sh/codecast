// The part of a deploy pill that ticks: how long a deploy still waiting or
// going out has been at it (lib/deploys/deployPill). Its glyph and tone carry
// the state. A pull request's or commit's state after its name is its change's
// track (components/changes/RefChangeSegment).
import { useNowWhen } from "../../hooks/useCoarseNow";
import { deployPillElapsed } from "../../lib/deploys/deployPill";

/** How long a deploy still waiting or going out has been at it, after its name; nothing once settled. No animation. */
export function DeployPillSuffix({ deploy }: { deploy: any }) {
  const now = useNowWhen((t) => deployPillElapsed(deploy, t) ?? "", 15_000);
  const elapsed = deployPillElapsed(deploy, now);
  return elapsed ? <span className="self-baseline whitespace-nowrap tabular-nums font-normal opacity-60 ml-[0.25em]">{elapsed}</span> : null;
}
