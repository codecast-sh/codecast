// The sticky filter: which user-role messages are a person's own ask. Shared
// by the sticky prompt header and message navigator (web, iOS) and by the
// Convex typed-send counters, so it must stay free of DOM, React and web-only
// dependencies, and import by relative path.

import { isCommandMessage, isStrippedCommand, parseBashInput, parseBashOutput, cleanContent, isSystemMessage } from "./conversationProcessor";
import { cleanUserMessage, isBareNudge, isSpawnedTaskPrompt } from "../components/sessionMessage";
import { isTurnInterruptionNotice, parseDecisionAnswer } from "@codecast/shared/contracts";

// A slash command ("/model opus") and `!` bash mode are the human talking to
// their client, not to the agent. Both are stored as tag soup
// ("<command-name>/model</command-name>…<command-args>opus</command-args>"),
// so a surface that only strips tags paints "/model model opus" as if it were
// a prompt. The thread already renders them as command blocks.
function isClientCommand(raw: string): boolean {
  return isCommandMessage(raw)
    || isStrippedCommand(raw.trim()) !== null
    || parseBashInput(raw) !== null
    || parseBashOutput(raw) !== null;
}

// The text a sticky prompt header may show for a user message, or null when
// the message is not the human's own ask: anything machinery delivered (a
// trigger run, a cast send, a teammate broadcast), a spawned run's opening
// briefing, a bare nudge, a command aimed at the client, or a decision answer
// (a tap on a card, stored as "Decision: <label>", tagged or legacy). Every sticky
// source (timeline, cached user list, last-message fallback) must agree, so
// they all go through here.
export function stickyPromptContent(raw: string | null | undefined): string | null {
  if (!raw || isSpawnedTaskPrompt(raw) || isClientCommand(raw) || isTurnInterruptionNotice(raw) || parseDecisionAnswer(raw)) return null;
  const display = cleanUserMessage(raw);
  return display && !isBareNudge(display) ? display : null;
}

// A user message the sticky prompt may show: the human's own ask (not machine
// delivered, not a spawned briefing, not a bare nudge, not a client command),
// with visible text that is not a system message.
export function isStickyEligible(content: string): boolean {
  if (stickyPromptContent(content) === null) return false;
  const display = cleanContent(content);
  return display.length > 0 && !isSystemMessage(display);
}
