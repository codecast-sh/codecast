// The parts of a deploy pill and a change's reach that tick or carry their own
// look (lib/deploys/deployLook): the words after a deploy's name, and the
// reach segment after a merged pull request's or main commit's name.
import { useNowWhen } from "../../hooks/useCoarseNow";
import { REACH_LOOK, deployPillSuffix } from "../../lib/deploys/deployPill";
import { PR_STATE_META, type PrStateKey } from "../../lib/prView";
import { accentVar } from "../../lib/externalEvents";
import { FAILED_ICON, REACH_ICON, TONE_TEXT } from "../../lib/deploys/deployLook";
import type { ReachState } from "@codecast/shared/contracts/deployReach";

/** The words after a deploy's name in its pill. One still waiting or deploying ticks once a minute; no animation. */
export function DeployPillSuffix({ deploy }: { deploy: any }) {
  const ticks = deploy.status === "running" || deploy.status === "requested";
  const now = useNowWhen((t) => (ticks ? deployPillSuffix(deploy, t) : ""), 15_000);
  return <span className="self-baseline whitespace-nowrap">· {deployPillSuffix(deploy, now)}</span>;
}

/** A pull request's state after its pill's name, in the word and color its page uses, when it has no reach to say instead. */
export function PrStateSegment({ state }: { state: PrStateKey }) {
  const meta = PR_STATE_META[state];
  return <span data-pr-state={state} className="self-baseline whitespace-nowrap shrink-0" style={{ color: accentVar(meta.accent) }}>· {meta.label.toLowerCase()}</span>;
}

/** A change's reach after its pill's name: the separator deploy pills use, then glyph and word in the reach's tone. A failed deploy wears a red tint of its own. */
export function ReachSegment({ state }: { state: ReachState }) {
  const look = REACH_LOOK[state];
  const Icon = REACH_ICON[state];
  const failed = state === "failed";
  return (
    <span data-reach={state} className={`self-baseline inline-flex items-baseline gap-[0.2em] whitespace-nowrap shrink-0 ${TONE_TEXT[look.tone]}`}>
      ·
      <span className={`inline-flex items-baseline gap-[0.2em] ${failed ? "bg-sol-red/[0.18] rounded-[0.2em] px-[0.15em] -mx-[0.05em]" : ""}`}>
        <Icon aria-hidden className={`self-center w-[0.9em] h-[0.9em] shrink-0 ${failed ? FAILED_ICON : ""}`} />
        {look.word}
      </span>
    </span>
  );
}
