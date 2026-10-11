"use client";
// A goal as one line (cohesive build spec §6): who owns it, how it is going,
// the number it is read by with its trend, and its target day. A goal's
// progress is its metric, so no task bar. The owner and the status are the
// pickers the goal's sheet uses: a pick paints the store at once and rides
// updateInitiative to the server.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { OwnerChip } from "../../initiatives/InitiativeAtoms";
import { GoalGlyph } from "./lineAtoms";
import { goalFacts } from "./lineFacts";
import { ObjectLine, type ObjectLineProps } from "./ObjectLine";

export { GoalGlyph, GoalMeasure, GoalOwnerPick, GoalStatusPick } from "./lineAtoms";

export type GoalLineProps = { goal: InitiativeRow; now: number; editable?: boolean } & Pick<ObjectLineProps, "depth" | "expanded" | "onToggle" | "sub" | "selected">;

export function GoalLine({ goal, now, editable = true, ...rest }: GoalLineProps) {
  return (
    <ObjectLine
      kind="goal"
      id={goal._id}
      target={{ kind: "initiative", ref: goal.short_id || goal._id }}
      glyph={<GoalGlyph />}
      title={goal.title}
      {...goalFacts(goal, now, editable)}
      face={goal.owner ? <OwnerChip owner={goal.owner} size={16} nameless /> : null}
      data-line-ref={goal.short_id || undefined}
      {...rest}
    />
  );
}
