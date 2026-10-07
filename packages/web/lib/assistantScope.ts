// Hosted mode's one scope: the assistant's work, or everything (the person
// widened it with the Assistant/Everything switch, `ui.hosted_inbox_everything`).
// Every surface that lists work by who did it reads this module: the inbox
// panel and its keyboard walk (chipMatchesSession), the rail and dock badges
// (hooks/useNeedsInputCount), Approvals and its rail count, Routines and the
// panel's next-routine strip, To-dos and Notes. One rule, so none of them can drift.
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

/** Whether a conversation may come back on its own (boot restore, adopting
 *  the top of the inbox): in the Assistant scope only the assistant's do, so
 *  the main pane never opens on work the list beside it leaves out. A link
 *  or a click opens anything. */
export function restorableIn(only: boolean, row: { agent_type?: string | null } | null | undefined): boolean {
  return !!row && (!only || inAssistantScope(row.agent_type));
}

/** A row that carries its conversation's agent type. */
export const bySessionAgent = (row: { agent_type?: string | null }): boolean => inAssistantScope(row.agent_type);

/** A routine is the assistant's when its home is a hosted conversation. */
export const isAssistantRoutine = (task: { hosted_home?: boolean | null }): boolean => task.hosted_home === true;

/** A to-do is the assistant's: one rule with the assistant's own list_tasks
 *  (@codecast/shared/tasks isAssistantTask). */
export { isAssistantTask } from "@codecast/shared/tasks";

/** A note is the assistant's (or the person's own) when no coding work made
 *  it: it belongs to no project or plan, it is a plain note rather than a
 *  plan, spec or investigation an agent filed, and it was either written in
 *  an assistant conversation or by hand outside any session. Read over the
 *  notes shelf (@codecast/shared/docs isOnNotesShelf). `assistantConversations`
 *  holds the assistant's conversation ids (useAssistantConversationIds). */
export function isAssistantDoc(
  doc: { project_id?: unknown; plan_id?: unknown; doc_type?: string | null; conversation_id?: unknown },
  assistantConversations: ReadonlySet<string>,
): boolean {
  if (doc.project_id || doc.plan_id) return false;
  if (doc.doc_type && doc.doc_type !== "note") return false;
  return !doc.conversation_id || assistantConversations.has(String(doc.conversation_id));
}

/** The quiet line under a scoped list that says what Everything adds. */
export function moreInEverything(hidden: number): string | null {
  // A developer's fleet runs to four digits; past a handful the number only
  // tells someone with a few of their own that a crowd of unknown work
  // exists, so it is named without one.
  if (hidden <= 0) return null;
  return hidden < 10 ? `${hidden} more in Everything` : "More in Everything";
}
