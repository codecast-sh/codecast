import { hasAgentSetupMarker } from "@codecast/shared/contracts";
import { sameMessageAuthor } from "./messageAuthors";
import { isAlwaysVisibleToolCall, isHiddenStubMessage, parseCastCommand, stripSystemTags } from "../components/conversation/classify";
import type { Message, ReceiptEntry, TimelineItem, UserMessageKind } from "../components/conversation/types";


/** The session a `cast send` reached: the first bare word after the verb
 *  (flags such as --wake may come first). Null for any other cast command. */
export function sentToRef(cmd: { category: string; subcommand: string; args: string } | null | undefined): string | null {
  if (!cmd || cmd.category !== "send") return null;
  const words = [cmd.subcommand, ...cmd.args.split(/\s+/)].filter(Boolean);
  for (const w of words) {
    if (w.startsWith("-")) continue;
    return /^[A-Za-z0-9]{5,}$/.test(w) ? w : null;
  }
  return null;
}

export type TurnAggregates = ReturnType<typeof buildTurnAggregates>;

/** Turns, receipts and routing for one timeline; see useTimelineTurns. O(n). */
export function buildTurnAggregates({ timeline, messages, userKindOf, messageAuthors, hasMoreBelow }: {
  timeline: TimelineItem[];
  messages: Message[];
  userKindOf: (msgId: string) => UserMessageKind["kind"] | undefined;
  messageAuthors: Map<string, string | undefined>;
  hasMoreBelow: boolean | undefined;
}) {

    const TURN_BOUNDARY_KINDS = new Set(['normal', 'direct_user', 'command', 'plan', 'session_handoff', 'context_recovery', 'session_message', 'chat_wake', 'agent_switch', 'machine_move', 'session_escalation']);
    const turnKeyOf = new Map<string, string>();      // msgId -> turn key
    const firstAssistOf = new Map<string, string>();  // turn key -> first assistant msgId
    const lastTextOf = new Map<string, string>();     // turn key -> last text-bearing msgId
    // startedAt/endedAt: the prompt that opened the turn (else its first reply)
    // to its last reply, which is how long the agent worked.
    const statsOf = new Map<string, { messages: number; tools: number; preview: string; startedAt: number; endedAt: number }>();
    const receiptOf = new Map<string, ReceiptEntry[]>(); // owner msgId -> folded hideable tools, per source message
    const absorbed = new Set<string>();                // msgId folded into an earlier receipt
    // Where a turn's message went (sentToRef above, scopes-and-feed.md F4.2), keyed
    // by the boundary user message that opened the turn: when the next turn
    // began (so a wake card claims only the hands started inside its window),
    // and the sessions the agent ran `cast send` to. A window that runs off
    // the loaded page closes at the page's last message, never at "forever".
    const routingOf = new Map<string, { until: number | null; sentTo: string[] }>();
    let curBoundary: string | null = null;
    let lastLoadedAt = 0;
    let curKey: string | null = null;
    let promptAt: number | null = null;                // the open prompt's time, until a turn claims it
    let ownerId: string | null = null;                 // current segment's receipt owner
    let previousAssistant: Message | null = null;
    // Results arrive on later user rows; a setup marker in one keeps its tool out of the receipt.
    const setupResults = new Map<string, { content?: string }>();
    // Scanned over messages, not the timeline: a row that only carries results is not a timeline item.
    for (const m of messages) {
      for (const r of m.tool_results ?? []) {
        if (hasAgentSetupMarker(r.content)) setupResults.set(r.tool_use_id, r);
      }
    }
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.timestamp > lastLoadedAt) lastLoadedAt = msg.timestamp;
      if (msg.role === 'user') {
        // Only a genuine new prompt ends the current turn; tool-result carriers,
        // interrupts, notifications, etc. are part of the ongoing response.
        if (TURN_BOUNDARY_KINDS.has(userKindOf(msg._id) ?? 'normal')) {
          curKey = null;
          ownerId = null;
          if (curBoundary) routingOf.get(curBoundary)!.until = msg.timestamp;
          curBoundary = msg._id;
          promptAt = msg.timestamp;
          routingOf.set(msg._id, { until: null, sentTo: [] });
        }
        continue;
      }
      if (msg.role !== 'assistant') continue;
      if (isHiddenStubMessage(msg)) continue;
      const hasText = !!(msg.content && stripSystemTags(msg.content).trim().length > 0);
      const tools = msg.tool_calls ?? [];
      if (curBoundary) {
        const routing = routingOf.get(curBoundary)!;
        for (const tc of tools) {
          const ref = sentToRef(parseCastCommand(tc));
          if (ref && !routing.sentTo.includes(ref)) routing.sentTo.push(ref);
        }
      }
      const hasVisible = hasText || tools.length > 0 || (!!msg.images?.length);
      if (!hasVisible) continue;
      if (previousAssistant && !sameMessageAuthor(previousAssistant, msg, messageAuthors)) {
        curKey = null;
        ownerId = null;
      }
      previousAssistant = msg;
      if (curKey === null) {
        curKey = msg._id;
        firstAssistOf.set(curKey, msg._id);
        statsOf.set(curKey, { messages: 0, tools: 0, preview: "", startedAt: promptAt ?? msg.timestamp, endedAt: msg.timestamp });
        promptAt = null;
      }
      turnKeyOf.set(msg._id, curKey);
      const stats = statsOf.get(curKey)!;
      if (hasText) { stats.messages += 1; lastTextOf.set(curKey, msg._id); }
      stats.tools += tools.length;
      if (msg.timestamp > stats.endedAt) stats.endedAt = msg.timestamp;
      if (!stats.preview && hasText) {
        stats.preview = stripSystemTags(msg.content || "").trim().split("\n")[0].slice(0, 140);
      }
      const hideable = tools.filter(tc => !isAlwaysVisibleToolCall(tc, setupResults.get(tc.id)));
      const entry: ReceiptEntry = { messageId: msg._id, messageUuid: msg.message_uuid, timestamp: msg.timestamp, tools: hideable };
      // Segment ownership: a text message opens a new segment and owns its own
      // tools; a tool-only message folds into the current owner (or becomes one).
      if (hasText) {
        ownerId = msg._id;
        receiptOf.set(msg._id, hideable.length ? [entry] : []);
      } else if (ownerId) {
        if (hideable.length) receiptOf.get(ownerId)!.push(entry);
        // A message carrying an always-visible block (poll, plan write) must
        // still render that block — fold its hideable tools into the receipt but
        // don't absorb the message itself.
        if (hideable.length === tools.length) absorbed.add(msg._id);
      } else {
        ownerId = msg._id;
        receiptOf.set(msg._id, hideable.length ? [entry] : []);
      }
    }
    if (curBoundary && hasMoreBelow) routingOf.get(curBoundary)!.until = lastLoadedAt;
    return { turnKeyOf, firstAssistOf, lastTextOf, statsOf, receiptOf, absorbed, routingOf, setupResults };
}
