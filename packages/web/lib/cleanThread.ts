import { CLOUD_AGENT_ACTION_SUBTYPE } from "@codecast/shared/contracts";
import { DELIVERY_FAILED_SUBTYPE, parseDeliveryFailedNotice } from "@codecast/shared/contracts/deliveryFailed";
import { sayTextOf } from "../components/castCommand";
import { FOLD_KEPT_USER_KINDS, isCleanVisibleToolCall, isHiddenStubMessage, parseCastCommand, stripSystemTags } from "../components/conversation/classify";
import type { Message, TimelineItem, ToolCall, UserMessageKind } from "../components/conversation/types";

/** One agent row a clean thread draws: what it said, the cards that wait on the person, and whether its name heads it. */
export type CleanRow = { text: string; tools: ToolCall[]; header: boolean };

export type CleanThread = {
  rows: Map<string, CleanRow>;
  /** The person's message that opened the newest exchange, while nothing in it has reached them yet. */
  awaitingReplyTo: string | null;
};

// User rows that continue the exchange in progress rather than open one: tool
// results, the expansion of what the person typed, compaction and stubs.
const CONTINUES_EXCHANGE = new Set<UserMessageKind["kind"]>([
  "tool_results_only", "empty", "noise", "continuation", "skill_expansion", "compaction_prompt", "compaction_summary", "poll_response", "bash_output", "interrupt",
]);

/**
 * The agent's side of a clean thread (a role's or the workspace agent's
 * conversation). The thread is a run of exchanges, each opened by the person
 * (their message, their answer to a decision, a chat mention) or by a machine
 * (a trigger, a colleague's message, a handoff). An exchange shows what the
 * agent said with `cast say` and the cards addressed to the person (a
 * question, a decision, a file); its thinking, its tools and the prose
 * between them are working notes and draw nothing. An exchange the person
 * opened that said nothing shows its latest reply, so a question is never
 * left looking unanswered when the agent forgot to say its answer. A row
 * absent from the map renders nothing.
 */
export function buildCleanThread({ timeline, userKindOf, resultOf }: {
  timeline: TimelineItem[];
  userKindOf: (msgId: string) => UserMessageKind["kind"] | undefined;
  resultOf: (toolUseId: string) => { content?: string } | undefined;
}): CleanThread {
  type Exchange = { opener: string | null; person: boolean; said: boolean; lastText: string | null; members: { msg: Message; says: string[] }[] };
  const exchanges: Exchange[] = [];
  let cur: Exchange | null = null;
  for (const item of timeline) {
    if (item.type !== "message") continue;
    const msg = item.data as Message;
    if (msg.role === "user") {
      const kind = userKindOf(msg._id) ?? "normal";
      if (CONTINUES_EXCHANGE.has(kind)) continue;
      cur = { opener: msg._id, person: FOLD_KEPT_USER_KINDS.has(kind), said: false, lastText: null, members: [] };
      exchanges.push(cur);
      continue;
    }
    if (msg.role !== "assistant" || isHiddenStubMessage(msg)) continue;
    if (!cur) { cur = { opener: null, person: false, said: false, lastText: null, members: [] }; exchanges.push(cur); }
    const says = (msg.tool_calls ?? []).map((tc) => sayTextOf(parseCastCommand(tc))).filter((t): t is string => !!t);
    if (says.length) cur.said = true;
    if (msg.content && stripSystemTags(msg.content).trim()) cur.lastText = msg._id;
    cur.members.push({ msg, says });
  }

  const rows = new Map<string, CleanRow>();
  let awaitingReplyTo: string | null = null;
  for (const ex of exchanges) {
    let header = true;
    for (const { msg, says } of ex.members) {
      let text = says.join("\n\n");
      if (!ex.said && ex.person && ex.lastText === msg._id) text = stripSystemTags(msg.content ?? "").trim();
      const tools = (msg.tool_calls ?? []).filter((tc) => isCleanVisibleToolCall(tc, resultOf(tc.id)));
      if (!text.trim() && !tools.length) continue;
      rows.set(msg._id, { text, tools, header });
      header = false;
    }
    awaitingReplyTo = ex.person && header ? ex.opener : null;
  }
  return { rows, awaitingReplyTo };
}

// System rows that record the agent's own machinery: trigger fires, compaction,
// hook summaries, local commands. A clean thread leaves them to the session view.
const MACHINE_SYSTEM_SUBTYPES = new Set(["scheduled_task_prompt", "scheduled_task_fire", "compact_boundary", "compaction_summary", "stop_hook_summary", "local_command", "away_summary", CLOUD_AGENT_ACTION_SUBTYPE]);

/**
 * Whether a clean thread draws a system row. What explains the agent's
 * silence to the person stays (a usage limit, an error, their own message
 * that never reached it); the machinery and a failed delivery of a machine's
 * prompt (a trigger, a colleague's message) do not.
 */
export function cleanKeepsSystemRow(content: string | undefined, subtype: string | undefined): boolean {
  if (subtype && MACHINE_SYSTEM_SUBTYPES.has(subtype)) return false;
  if (subtype === DELIVERY_FAILED_SUBTYPE) {
    const notice = parseDeliveryFailedNotice(content ?? "");
    return !!notice && !notice.message.trimStart().startsWith("<");
  }
  return true;
}

/** Whether a standing agent's thread reads as a clean chat: its seat's switch (anchors.clean_chat). */
export function cleanChatOf(anchors: Record<string, { conversation_id?: string | null; clean_chat?: boolean }> | undefined, conversationId: string | undefined): boolean {
  if (!anchors || !conversationId) return false;
  for (const a of Object.values(anchors)) if (a?.conversation_id === conversationId) return !!a.clean_chat;
  return false;
}
