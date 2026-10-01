import type { ConvoMessage } from '@platform/evals';
import { UsageError } from '@platform/evals/cli';

import { bootstrapMessage } from '../../../../convex/convex/anchors';
import { splitLineRef, toConvoMessages, toRows, type CliReadMessage } from '../../adapters/convo';
import { readFrozenVerbs } from '../../served';
import type { Captured, CaptureCtx, SurfaceImpl } from '../../surface';
import { claudeModel, describeTurn, findSnapshot, harnessNote, servedDirFor, type StandingWorld } from '../roleWake/world';
import { meta } from './meta';

// anchor-brief: the opening turn of a standing session, the message that
// brings a workspace's agent or a role online. A real freeze replays the
// opening prod sent (read through /cli/read) against reads captured now, so it
// tests the agent and the model. A fixture renders bootstrapMessage over
// synthetic facts (and through it roleOpeningMessage, when the facts name a
// role), so it tests edits to the builders too.

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
}

export function openingOf(snap: AnchorBriefSnap): string {
  if (snap.opening) return snap.opening.text;
  if (!snap.facts) throw new Error('anchor-brief snapshot carries neither an opening nor fixture facts');
  return bootstrapMessage(snap.facts);
}

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
    const a = await ctx.agent({ prompt: `${openingOf(snap)}\n${harnessNote(readFrozenVerbs(serveDir))}`, serveDir, model: ctx.model, maxTurns: 80 });
    return { reply: a.said.join('\n\n') };
  },

  // The route gates (frozen-reads, no-unexpected-writes) are this surface's gates: an opening turn reads and writes nothing.
  gates: () => [],

  describe: (snap: AnchorBriefSnap): ConvoMessage[] => describeTurn(openingOf(snap), snap.opening?.at ?? snap.captured_at, 'opening'),

  productionReply: (snap: AnchorBriefSnap) => (snap.reply?.length ? { messages: toConvoMessages(toRows(snap.reply)) } : null),
};

export default impl;
