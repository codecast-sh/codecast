// How a deploy reference and a change's reach look on the web: the glyph and
// colors for each state the shared words name (deployPill). The pill itself
// (EntityIdPill) and its parts (components/deploys/deployRefLook) draw these.
import { Circle, CircleCheck, CircleMinus, CircleX, Clock, Rocket, Undo2, type LucideIcon } from "lucide-react";
import type { ReachState } from "@codecast/shared/contracts/deployReach";
import { deployPillState, deployTone, isRollback, type DeployPillState, type DeployTone } from "./deployPill";

export const TONE_TEXT: Record<DeployTone, string> = {
  green: "text-sol-green",
  yellow: "text-sol-yellow",
  red: "text-sol-red",
  orange: "text-sol-orange",
  muted: "text-sol-text-muted",
  dim: "text-sol-text-dim",
};

/** A pill's chrome in a tone: the same faint tint every reference wears. */
export const TONE_CHROME: Record<DeployTone, string> = {
  green: "bg-sol-green/[0.08] text-sol-green hover:bg-sol-green/[0.16]",
  yellow: "bg-sol-yellow/[0.08] text-sol-yellow hover:bg-sol-yellow/[0.16]",
  red: "bg-sol-red/[0.08] text-sol-red hover:bg-sol-red/[0.16]",
  orange: "bg-sol-orange/[0.08] text-sol-orange hover:bg-sol-orange/[0.16]",
  muted: "bg-sol-text-dim/[0.08] text-sol-text-muted hover:bg-sol-text-dim/[0.16]",
  dim: "bg-sol-text-dim/[0.08] text-sol-text-dim hover:bg-sol-text-dim/[0.16]",
};

/** A failure must be seen before it is read: a stronger tint and a heavier glyph than any other state. */
export const FAILED_CHROME = "bg-sol-red/[0.18] text-sol-red hover:bg-sol-red/[0.26]";
export const FAILED_ICON = "[stroke-width:3]";

export const DEPLOY_STATE_ICON: Record<DeployPillState, LucideIcon> = {
  waiting: Clock,
  going_out: Rocket,
  live: CircleCheck,
  replaced: CircleCheck,
  failed: CircleX,
  cancelled: CircleMinus,
};

export const REACH_ICON: Record<ReachState, LucideIcon> = {
  live: CircleCheck,
  going_out: Rocket,
  queued: Clock,
  failed: CircleX,
  rolled_back: Undo2,
  waiting: Circle,
};

/** A deploy pill's glyph and chrome, from its row at `now`. A rollback wears the undo glyph in every state. */
export function deployLook(d: any, now: number): { state: DeployPillState; tone: DeployTone; Icon: LucideIcon; chrome: string; iconClass: string } {
  const state = deployPillState(d);
  const tone = deployTone(d, now);
  const failed = state === "failed";
  return {
    state,
    tone,
    Icon: isRollback(d) ? Undo2 : DEPLOY_STATE_ICON[state],
    chrome: failed ? FAILED_CHROME : TONE_CHROME[tone],
    iconClass: failed ? FAILED_ICON : state === "replaced" ? "opacity-50" : "",
  };
}
