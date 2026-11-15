import type { PollSelections } from "./pollPayload";

// What this tab already sent for a question card, so a remount does not offer it again.
export const sentByCall = new Map<string, PollSelections>();
/** Reopen a card whose press became a proposal rather than an answer. */
export const forgetModernAskSent = (toolId: string) => { sentByCall.delete(toolId); };
/** Close a card whose answer was sent from elsewhere (a teammate's proposal). */
export const markModernAskSent = (toolId: string) => { if (!sentByCall.has(toolId)) sentByCall.set(toolId, {}); };
