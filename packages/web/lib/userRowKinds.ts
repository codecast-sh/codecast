// What each user-role row in a conversation is (classifyUserMessage), read
// with its neighbours, and which rows fold into the one before them: a slash
// command's expansion, `!` bash output, a model switch's stdout, a move's
// second notice. Pure, so web's timeline and the phone's transcript sort rows
// the same way.
import { isCommandMessage, initialSubagentPromptId } from "./conversationProcessor";
import { isModelSwitchStdout } from "@codecast/shared/contracts";
import { isToolResultCarrier, stripInjectionNoise } from "../components/sessionMessage";
import { classifyUserMessage } from "../components/conversation/classify";
import type { Message, TimelineItem, UserMessageKind } from "../components/conversation/types";

// One move writes two notices: Convex's divider when the picker fires and the
// destination daemon's reorientation. The resumed CLI can report what the move
// stopped (a background task) between them, so those rows don't end the run.
const MOVE_PASSTHROUGH_KINDS = new Set(['task_notification', 'background_agent_stopped', 'noise']);

/** Fold the machine_move rows after timeline[i] into it: marks them consumed and
 *  records their text as the head row's extra detail. */
export function foldMachineMove(
  timeline: TimelineItem[],
  i: number,
  kindOf: Map<string, UserMessageKind>,
  consumed: Set<string>,
  extraOf: Map<string, string>,
): void {
  const head = timeline[i].data as Message;
  const extras: string[] = [];
  for (let j = i + 1; j < timeline.length; j++) {
    if (timeline[j].type !== 'message') continue;
    const later = timeline[j].data as Message;
    if (later.role !== 'user') break;
    const kind = kindOf.get(later._id)?.kind;
    if (kind && MOVE_PASSTHROUGH_KINDS.has(kind)) continue;
    if (kind !== 'machine_move') break;
    consumed.add(later._id);
    if (later.content) extras.push(later.content);
  }
  if (extras.length) extraOf.set(head._id, extras.join("\n\n"));
}

export function classifyUserRows(
  timeline: TimelineItem[],
  messages: Message[],
  opts: { agentType?: string; parentConversationId?: string | null; hasMoreAbove?: boolean },
): Map<string, UserMessageKind> {
  const map = new Map<string, UserMessageKind>();
  const initialPromptId = initialSubagentPromptId(messages, opts.parentConversationId, opts.hasMoreAbove);
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (item.type !== 'message') continue;
    const msg = item.data as Message;
    if (msg.role !== 'user') continue;
    let immediatePrev: Message | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (timeline[j].type === 'message') { immediatePrev = timeline[j].data as Message; break; }
    }
    let contextPrev: Message | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const p = timeline[j];
      if (p.type !== 'message') continue;
      const pm = p.data as Message;
      if (isToolResultCarrier(pm)) continue;
      if (pm.role === 'user' && pm.content && isCommandMessage(pm.content)) continue;
      contextPrev = pm;
      break;
    }
    const kind = classifyUserMessage(msg, opts.agentType, immediatePrev, contextPrev);
    map.set(msg._id, msg._id === initialPromptId && kind.kind === "normal"
      ? { kind: "session_message", from: opts.parentConversationId!.slice(0, 7), body: stripInjectionNoise(msg.content || "") }
      : kind);
  }
  return map;
}

export type CommandExpansions = {
  byCommand: Map<string, string>;
  consumed: Set<string>;
  bashByInput: Map<string, { stdout: string; stderr: string }>;
  machineMoveExtra: Map<string, string>;
};

// Pair each slash-command invocation with its expansion (the body of the command's
// .md file, emitted by Claude Code as the next user message). They render as one
// command block, so the expansion message is suppressed. Applied only in the full
// (non-collapsed) view; collapsed keeps its compact one-pill behavior.
export function pairCommandExpansions(timeline: TimelineItem[], userMsgKindMap: Map<string, UserMessageKind>): CommandExpansions {
  const byCommand = new Map<string, string>(); // command msg _id -> expansion content
  const consumed = new Set<string>();          // expansion msg _ids
  // Same pairing for `!` bash mode: input msg _id -> the output msg's parsed streams.
  const bashByInput = new Map<string, { stdout: string; stderr: string }>();
  const machineMoveExtra = new Map<string, string>();
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (item.type !== 'message') continue;
    const msg = item.data as Message;
    if (msg.role !== 'user') continue;
    const kind = userMsgKindMap.get(msg._id)?.kind;
    if (kind !== 'command' && kind !== 'bash_input' && kind !== 'agent_switch' && kind !== 'machine_move') continue;
    if (kind === 'machine_move') {
      if (!consumed.has(msg._id)) foldMachineMove(timeline, i, userMsgKindMap, consumed, machineMoveExtra);
      continue;
    }
    let next: Message | null = null;
    for (let j = i + 1; j < timeline.length; j++) {
      if (timeline[j].type === 'message') { next = timeline[j].data as Message; break; }
    }
    if (!next || next.role !== 'user' || !next.content) continue;
    const nextKind = userMsgKindMap.get(next._id);
    if (kind === 'command' && nextKind?.kind === 'skill_expansion') {
      byCommand.set(msg._id, next.content);
      consumed.add(next._id);
    } else if (kind === 'agent_switch' && nextKind?.kind === 'agent_switch' && isModelSwitchStdout(next.content)) {
      // /model command + "Set model to …" stdout: keep the prettier stdout divider.
      consumed.add(msg._id);
    } else if (kind === 'bash_input' && nextKind?.kind === 'bash_output') {
      bashByInput.set(msg._id, { stdout: nextKind.stdout, stderr: nextKind.stderr });
      consumed.add(next._id);
    }
  }
  return { byCommand, consumed, bashByInput, machineMoveExtra };
}
