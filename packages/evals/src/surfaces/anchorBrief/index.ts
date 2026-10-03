import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { bootstrapMessage } from '../../../../convex/convex/anchors';
import { ANCHOR_REPLY_TIMEOUT_MS, buildAnchorWake } from '../../../../convex/convex/chat';
import { splitLineRef, toConvoMessages, toRows, type CliReadMessage } from '../../adapters/convo';
import type { Captured, CaptureCtx, SurfaceImpl } from '../../surface';
import { standingGates, type StandingLabel } from '../roleWake/actions';
import { claudeModel, describeTurn, findSnapshot, servedDirFor, withHarnessNote, type StandingWorld } from '../roleWake/world';
import { meta } from './meta';

// anchor-brief: the opening turn of a standing session, the message that
// brings a workspace's agent or a role online. A real freeze replays the
// opening prod sent (read through /cli/read) against reads captured now, so it
// tests the agent and the model. A fixture renders bootstrapMessage over
// synthetic facts (and through it roleOpeningMessage, when the facts name a
// role), so it tests edits to the builders too. A fixture may go on past the
// opening: each of its turns is the next message the standing session gets,
// sent into the same session (prompt-dry-run.ts --then), and the label's gates
// grade those turns, not the opening.

const HINT = '`./evals snapshot anchor-brief --session <id> --team <team> --role <handle> --name <name>`';

/** How far past the opening the capture reads for prod's own answer to it. */
const REPLY_WINDOW = 40;

export interface AnchorBriefSnap extends StandingWorld {
  /** A real freeze: the opening prod sent, where it sits in the session. */
  opening?: { text: string; at: string; line: number };
  /** What the session answered, up to the next message a person typed. */
  reply?: CliReadMessage[];
  /** A fixture: what bootstrapMessage is rendered over. */
  facts?: Parameters<typeof bootstrapMessage>[0];
  /** A fixture: the messages the session gets after its opening, in order. */
  turns?: FixtureTurn[];
}

/** A chat wake's facts; the reply deadline is prod's unless the fixture sets one. */
type ChatWakeFacts = Omit<Parameters<typeof buildAnchorWake>[0], 'deadlineMinutes'> & { deadlineMinutes?: number };

/** One later message: what a person typed into the session, or a chat wake rendered by prod's builder. */
export type FixtureTurn = { text: string } | { chat: ChatWakeFacts };

export function openingOf(snap: AnchorBriefSnap): string {
  if (snap.opening) return snap.opening.text;
  if (!snap.facts) throw new Error('anchor-brief snapshot carries neither an opening nor fixture facts');
  return bootstrapMessage(snap.facts);
}

export const turnText = (turn: FixtureTurn): string =>
  'text' in turn ? turn.text : buildAnchorWake({ ...turn.chat, deadlineMinutes: turn.chat.deadlineMinutes ?? Math.round(ANCHOR_REPLY_TIMEOUT_MS / 60_000) });

/** The session's messages as a moment: `first` with the harness note, then each fixture turn. */
const momentOf = (snap: AnchorBriefSnap, first: string): ConvoMessage[] =>
  [withHarnessNote(first, snap), ...(snap.turns ?? []).map(turnText)].map((text, i) => ({ ...describeTurn(text, snap.opening?.at ?? snap.captured_at, i ? `turn-${i + 1}` : 'opening')[0]!, n: i + 1 }));

/** Who a fixture's agent is, said plainly; its judge reads this where the opening would be. */
const agentLine = (facts: NonNullable<AnchorBriefSnap['facts']>): string =>
  `(The agent's opening instructions are the prompt under test and are not shown. The agent is ${facts.name}, the ${facts.scopeType === 'team' ? 'team' : 'personal'} workspace's standing agent for ${facts.scopeLabel}${facts.role ? `, seated as the role @${facts.role.handle}` : ''}.)`;

/** The run turn each chat wake's placeholder arrived in: the opening is turn 1, a fixture's first turn is turn 2. */
const placeholderTurns = (snap: AnchorBriefSnap): Record<string, number> =>
  Object.fromEntries((snap.turns ?? []).flatMap((t, i) => ('chat' in t ? [[String(t.chat.placeholderId), i + 2]] : [])));

/** The turn a fixture's label grades from: its first turn after the opening, else the opening itself. */
const gradedFrom = (snap: AnchorBriefSnap): number => (snap.turns?.length ? 2 : 1);

/** The assistant's answer to the opening: every message until the next one a person typed. */
export function replyAfter(messages: CliReadMessage[]): CliReadMessage[] {
  const out: CliReadMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' && m.content.trim() && !m.tool_results?.length) break;
    if (m.role === 'assistant' && m.content.trim()) out.push(m);
  }
  return out;
}

export async function captureAnchorBrief(ref: string, ctx: CaptureCtx): Promise<Captured> {
  const { conversation, line } = splitLineRef(ref);
  const at = line ?? 1;
  const world = findSnapshot('anchor-brief', 'session', conversation, HINT);
  const read = (await ctx.readConversation(conversation, { from: at, to: at + REPLY_WINDOW })) as { conversation: { id: string; title?: string; model?: string | null }; messages: CliReadMessage[] };
  const [first, ...rest] = read.messages;
  if (!first || first.line !== at || first.role !== 'user' || !first.content.trim()) {
    throw new UsageError(`line ${at} of ${conversation} is not a message a person or the server sent; name the opening's line, like anchor-brief@${conversation}:<line>`);
  }
  const model = claudeModel(read.conversation.model);
  const snapshot: AnchorBriefSnap = { captured_at: world.captured_at, served: world.served, opening: { text: first.content, at: first.timestamp, line: at }, reply: replyAfter(rest) };
  return {
    snapshot,
    name: `anchor-brief ${conversation.slice(0, 7)}:${at}`,
    subject: { kind: 'session', id: read.conversation.id, title: read.conversation.title ?? read.conversation.id },
    asOf: world.captured_at,
    anchor: { kind: 'message', id: `${conversation.slice(0, 7)}:${at}` },
    meta: { conversation_id: read.conversation.id, workspace: world.values.team, ...(model ? { model } : {}) },
  };
}

const impl: SurfaceImpl = {
  refForms: "anchor-brief@ needs the standing session's short id, and the opening's line when it is not line 1, like anchor-brief@jx7c6zk or anchor-brief@jx7c6zk:12 (capture its world first: ./evals snapshot anchor-brief --session <id> --team T --role <handle> --name n)",

  capture: captureAnchorBrief,

  async replay(snap: AnchorBriefSnap, ctx) {
    const serveDir = servedDirFor(snap, ctx, meta);
    const then = (snap.turns ?? []).map(turnText);
    const a = await ctx.agent({ prompt: withHarnessNote(openingOf(snap), snap), serveDir, model: ctx.model, maxTurns: 80, ...(then.length ? { then } : {}) });
    return { reply: a.turns.slice(gradedFrom(snap) - 1).flat().join('\n\n') };
  },

  // The route gates (frozen-reads, no-unexpected-writes) hold every turn; a fixture's label adds its scenario's gate over the turns after the opening.
  gates: (snap: AnchorBriefSnap, out, label?: StandingLabel) => standingGates(out.agents, label, gradedFrom(snap), [], { placeholderTurns: placeholderTurns(snap) }),

  describe: (snap: AnchorBriefSnap): ConvoMessage[] => momentOf(snap, openingOf(snap)),

  // A fixture's opening is rendered by the builder under test, so its judge reads who the agent is in its place; a real freeze's opening is the text prod sent, the same in every arm.
  judgeMoment: (snap: AnchorBriefSnap): ConvoMessage[] => momentOf(snap, snap.opening || !snap.facts ? openingOf(snap) : agentLine(snap.facts)),

  // A chat wake tells the agent to fill its placeholder with `cast chat reply`; that write is the wake's, so it is allowed for the wake's own placeholder and nothing else.
  allowedRefusals: (snap: AnchorBriefSnap) => Object.keys(placeholderTurns(snap)).map((ph) => `^chat reply ["']?${ph}\\b`),

  productionReply: (snap: AnchorBriefSnap) => (snap.reply?.length ? { messages: toConvoMessages(toRows(snap.reply)) } : null),
};

export default impl;
