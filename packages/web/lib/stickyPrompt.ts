// The sticky filter: which user-role messages are a person's own ask. Shared
// by the sticky prompt header and message navigator (web, iOS) and by the
// Convex typed-send counters, so it must stay free of DOM, React and web-only
// dependencies, and import by relative path.

import { isCommandMessage, isStrippedCommand, parseBashInput, parseBashOutput, cleanContent, isSystemMessage } from "./conversationProcessor";
import { cleanUserMessage, isBareNudge, isSpawnedTaskPrompt } from "../components/sessionMessage";
import { isTurnInterruptionNotice, parseDecisionAnswer } from "@codecast/shared/contracts";
import { LRUCache } from "./lruCache";

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
//
// Both answers are pure functions of the text, and a conversation screen asks
// them for every prompt on each scroll and window change, so they are cached
// by content.
const contentCache = new LRUCache<string, string | null>(4000);
const eligibleCache = new LRUCache<string, boolean>(4000);

export function stickyPromptContent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hit = contentCache.get(raw);
  if (hit !== undefined) return hit;
  let out: string | null = null;
  if (!(isSpawnedTaskPrompt(raw) || isClientCommand(raw) || isTurnInterruptionNotice(raw) || parseDecisionAnswer(raw))) {
    const display = cleanUserMessage(raw);
    out = display && !isBareNudge(display) ? display : null;
  }
  contentCache.set(raw, out);
  return out;
}

// A user message the sticky prompt may show: the human's own ask (not machine
// delivered, not a spawned briefing, not a bare nudge, not a client command),
// with visible text that is not a system message.
export function isStickyEligible(content: string): boolean {
  const hit = eligibleCache.get(content);
  if (hit !== undefined) return hit;
  let out = false;
  if (stickyPromptContent(content) !== null) {
    const display = cleanContent(content);
    out = display.length > 0 && !isSystemMessage(display);
  }
  eligibleCache.set(content, out);
  return out;
}
