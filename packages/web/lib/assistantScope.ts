// Hosted mode's one scope: the assistant's work, or everything (the person
// widened it with the Assistant/Everything switch, `ui.hosted_inbox_everything`).
// Every surface that lists work by who did it reads this module: the inbox
// panel and its keyboard walk (chipMatchesSession), the rail and dock badges
// (hooks/useNeedsInputCount), Approvals and its rail count, Routines and the
// panel's next-routine strip. One rule, so none of them can drift.
//
// A leaf: no store, no React, so the pure placement code and the views share it.
import { isHostedAgentType } from "@codecast/shared/contracts";
import { isHostedUi } from "../components/simple/lanePaths";

export type ScopeUi = { lane?: string; hosted_inbox_everything?: boolean } | null | undefined;

/** Whether lists show only the assistant's work: hosted mode, not widened. */
export function assistantScopeOnly(ui: ScopeUi): boolean {
  return isHostedUi(ui) && !ui?.hosted_inbox_everything;
}

/** Whether work by an agent of `agentType` is the assistant's. */
export function inAssistantScope(agentType: string | null | undefined): boolean {
  return isHostedAgentType(agentType);
}

/** `rows` narrowed to the assistant's when `only`, as the same array when
 *  not. `isAssistants` says whose a row is: a conversation by its agent type
 *  (bySessionAgent), a routine by its hosted home (isAssistantRoutine). */
export function withinScope<T>(rows: readonly T[], only: boolean, isAssistants: (row: T) => boolean): readonly T[] {
  return only ? rows.filter(isAssistants) : rows;
}

/** A row that carries its conversation's agent type. */
export const bySessionAgent = (row: { agent_type?: string | null }): boolean => inAssistantScope(row.agent_type);

/** A routine is the assistant's when its home is a hosted conversation. */
export const isAssistantRoutine = (task: { hosted_home?: boolean | null }): boolean => task.hosted_home === true;

/** The quiet line under a scoped list that says what Everything adds. */
export function moreInEverything(hidden: number): string | null {
  return hidden > 0 ? `${hidden} more in Everything` : null;
}
