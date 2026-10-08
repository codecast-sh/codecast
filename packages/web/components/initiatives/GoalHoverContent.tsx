"use client";
// What an `in-N` pill shows on hover (cohesive build spec D14): the goal's
// summary, the same head line its sheet and its line show (owner, health,
// its number against its target, its day), what it serves and what carries
// it, in the body every object card shares (ObjectCardBody): a click anywhere
// opens the goal, its sheet on the Org screen, a new tab on Cmd or Ctrl.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { ObjectCardBody } from "../identity/objectCard";
import { GoalSummary } from "../org/lines/ObjectSummary";

export function GoalHoverContent({ goal, onOpen }: { goal: InitiativeRow; onOpen?: (e: React.MouseEvent) => void }) {
  return (
    <ObjectCardBody kind="initiative" refId={goal.short_id} label="Open goal" foot={goal.short_id} onOpen={onOpen} data-initiative-hover={goal.short_id}>
      <GoalSummary goal={goal} />
    </ObjectCardBody>
  );
}
