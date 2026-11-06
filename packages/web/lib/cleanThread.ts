import { sayTextOf } from "../components/castCommand";
import { FOLD_KEPT_USER_KINDS, isCleanVisibleToolCall, parseCastCommand } from "../components/conversation/classify";
import type { Message, TimelineItem, ToolCall, UserMessageKind } from "../components/conversation/types";

/** One agent row a clean thread draws: what it said, the cards that wait on the person, and whether its name heads it. */
export type CleanRow = { text: string; tools: ToolCall[]; header: boolean };

// A turn a person opened: their message, or their answer to a decision.
const PERSON_OPENERS = new Set<UserMessageKind["kind"]>(["normal", "direct_user", "decision_answer"]);

/**
 * The agent's side of a clean thread (a role's or the workspace agent's
 * conversation): what it said with `cast say`, and the cards addressed to the
 * person (a question, a decision, a file). Its thinking, its tools and the
 * prose between them are working notes and draw nothing. A turn a person
 * opened that said nothing shows its last reply, so a question is never left
 * looking unanswered when the agent forgot to say its answer. A row absent
 * from the map renders nothing.
 */
export function buildCleanThread({ timeline, userKindOf, turnKeyOf, lastTextOf, resultOf }: {
  timeline: TimelineItem[];
  userKindOf: (msgId: string) => UserMessageKind["kind"] | undefined;
  turnKeyOf: ReadonlyMap<string, string>;
  lastTextOf: ReadonlyMap<string, string>;
  resultOf: (toolUseId: string) => { content?: string } | undefined;
}): Map<string, CleanRow> {
  const saysOf = new Map<string, string[]>();
  const turnsThatSaid = new Set<string>();
  for (const item of timeline) {
    if (item.type !== "message") continue;
    const msg = item.data as Message;
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;
    const says = msg.tool_calls.map((tc) => sayTextOf(parseCastCommand(tc))).filter((t): t is string => !!t);
    if (!says.length) continue;
    saysOf.set(msg._id, says);
    const key = turnKeyOf.get(msg._id);
    if (key) turnsThatSaid.add(key);
  }

  const rows = new Map<string, CleanRow>();
  let opener: UserMessageKind["kind"] | undefined;
  let headerDue = true;
  for (const item of timeline) {
    if (item.type !== "message") continue;
    const msg = item.data as Message;
    if (msg.role === "user") {
      const kind = userKindOf(msg._id) ?? "normal";
      if (FOLD_KEPT_USER_KINDS.has(kind)) { opener = kind; headerDue = true; }
      continue;
    }
    if (msg.role !== "assistant") continue;
    const key = turnKeyOf.get(msg._id);
    if (!key) continue;
    let text = saysOf.get(msg._id)?.join("\n\n") ?? "";
    if (!text && !turnsThatSaid.has(key) && lastTextOf.get(key) === msg._id && opener && PERSON_OPENERS.has(opener)) text = msg.content ?? "";
    const tools = (msg.tool_calls ?? []).filter((tc) => isCleanVisibleToolCall(tc, resultOf(tc.id)));
    if (!text.trim() && !tools.length) continue;
    rows.set(msg._id, { text, tools, header: headerDue });
    headerDue = false;
  }
  return rows;
}
