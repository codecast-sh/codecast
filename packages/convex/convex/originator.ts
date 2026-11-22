// The reads behind /cli/sessions/originator (`cast flow asker`): the chain
// from a session up to the one that started its line of work, and every line
// a person typed into the sessions on it, each with its provenance
// (lib/messageProvenance.ts). The route drives them through
// lib/originatorChain.readOriginator.
import { v } from "convex/values";
import { internalQuery } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { readableConversation, streamMessageRows } from "./conversations";
import { canOwnerOrTeamAccess } from "./privacy";
import { canAccessTask } from "./lib/access";
import { findTaskByRef } from "./taskEvidence";
import { isNonEmptyMessage } from "./lib/conversationBasics";
import type { ScanCursor } from "./lib/conversationRead";
import { commandExpansionName } from "../../web/lib/conversationProcessor";
import { launchedByProgram, mayBeTyped, messageProvenance } from "./lib/messageProvenance";
import { walkOriginatorChain, type ChainLink, type ChainStop, type TypedLine } from "./lib/originatorChain";

type Conv = Doc<"conversations">;

export type ChainEntry = { conversation_id: string; short_id: string; title: string; link: ChainLink | null };
export type OriginatorHead = {
  chain: ChainEntry[];
  stopped?: ChainStop;
  originator: {
    conversation_id: string;
    short_id: string;
    user_id: string;
    user_name: string | null;
    is_bot: boolean;
    launched_by_program: boolean;
  };
  task?: { short_id: string; chain: ChainEntry[]; stopped?: ChainStop };
};

const shortIdOf = (c: Conv) => c.short_id ?? String(c._id).slice(0, 7);
const nameOf = (u: Doc<"users"> | null) => u?.name || u?.github_username || u?.email?.split("@")[0] || null;

async function walkFrom(ctx: any, userId: Id<"users">, start: Conv) {
  const { hops, stopped } = await walkOriginatorChain<Conv & { _id: any }>({
    conversation: async (id) => {
      const nid = ctx.db.normalizeId("conversations", id);
      return nid ? await ctx.db.get(nid) : null;
    },
    canRead: (c) => canOwnerOrTeamAccess(ctx, userId, c),
    runSpawner: async (id) => {
      const nid = ctx.db.normalizeId("workflow_runs", id);
      const run = nid ? await ctx.db.get(nid) : null;
      return run?.spawner_conversation_id ? String(run.spawner_conversation_id) : null;
    },
    scheduleCreator: async (id) => {
      const nid = ctx.db.normalizeId("agent_tasks", id);
      const task = nid ? await ctx.db.get(nid) : null;
      return task?.created_by_conversation_id ? String(task.created_by_conversation_id) : null;
    },
  }, start);
  const chain = hops.map(({ conversation: c, link }) => ({
    conversation_id: String(c._id),
    short_id: shortIdOf(c),
    title: c.title || "New Session",
    link,
  }));
  return { chain, stopped, root: hops[hops.length - 1].conversation };
}

/** The chain from a session to its originator, and a task's filing session's chain when one is named. */
export const chain = internalQuery({
  args: { api_token: v.string(), conversation_id: v.string(), task: v.optional(v.string()) },
  handler: async (ctx, args): Promise<OriginatorHead | { error: string }> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
    if ("error" in access) return { error: access.error ?? "Access denied" };
    const userId = access.user._id;
    const walk = await walkFrom(ctx, userId, access.conv);
    const author = walk.root.author_user_id ?? walk.root.user_id;
    const authorRow = await ctx.db.get(author);
    const head: OriginatorHead = {
      chain: walk.chain,
      ...(walk.stopped ? { stopped: walk.stopped } : {}),
      originator: {
        conversation_id: String(walk.root._id),
        short_id: shortIdOf(walk.root),
        user_id: String(author),
        user_name: nameOf(authorRow),
        is_bot: !!authorRow?.is_bot,
        launched_by_program: launchedByProgram(walk.root),
      },
    };
    if (args.task) {
      const task = await findTaskByRef(ctx, args.task);
      if (!task || !(await canAccessTask(ctx, userId, task))) return { error: `Task ${args.task} not found` };
      const filedIn = task.created_from_conversation ? await ctx.db.get(task.created_from_conversation as Id<"conversations">) : null;
      const readable = filedIn && (await canOwnerOrTeamAccess(ctx, userId, filedIn));
      const taskWalk = readable ? await walkFrom(ctx, userId, filedIn) : null;
      head.task = {
        short_id: task.short_id ?? String(task._id),
        chain: taskWalk?.chain ?? [],
        ...(taskWalk?.stopped ? { stopped: taskWalk.stopped } : filedIn && !readable ? { stopped: "access_denied" as const } : {}),
      };
    }
    return head;
  },
});

type Row = { role: string; content?: string; timestamp: number };
type Candidate = { _id: string; line: number; content: string; client_id?: string; from_user_id?: string; timestamp: number };
/** Where a scan resumes: the cursor, the last line numbered, the row before it, and a candidate held until its next neighbour shows it is not a slash command's body. */
type ScanState = { after?: ScanCursor; line: number; prev?: Row; held?: Candidate };

const PREV_CHARS = 2_000;

/**
 * One scan step over a conversation: the lines a person typed, numbered as
 * `cast read` numbers them (non-empty rows in creation order), and the state
 * the next step resumes from, absent once the last row is read.
 */
export const typedStep = internalQuery({
  args: { api_token: v.string(), conversation_id: v.string(), state: v.optional(v.any()) },
  handler: async (ctx, args): Promise<{ typed: TypedLine[]; state?: ScanState } | { error: string }> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
    if ("error" in access) return { error: access.error ?? "Access denied" };
    const conv = access.conv;
    const s: ScanState = (args.state as ScanState | undefined) ?? { line: 0 };
    let { line, prev, held } = s;
    const candidates: Candidate[] = [];
    const cursor = await streamMessageRows(ctx, conv._id, s.after, "asc", (m) => {
      const nonEmpty = isNonEmptyMessage(m);
      if (nonEmpty) line++;
      const cur: Row = { role: m.role, content: m.content, timestamp: m.timestamp };
      // The held row was the body of the slash command this row invokes.
      if (held && prev && m.role === "user" && commandExpansionName(cur, prev) !== null) held = undefined;
      if (held) candidates.push(held);
      held = undefined;
      const isBody = prev?.role === "user" && m.role === "user" && commandExpansionName(prev, cur) !== null;
      if (nonEmpty && m.role === "user" && !m.tool_results?.length && !isBody && mayBeTyped(m.content)) {
        held = {
          _id: String(m._id),
          line,
          content: m.content!,
          client_id: m.client_id,
          from_user_id: m.from_user_id ? String(m.from_user_id) : undefined,
          timestamp: m.timestamp,
        };
      }
      prev = { ...cur, content: cur.content?.slice(0, PREV_CHARS) };
    });
    if (!cursor && held) candidates.push(held);

    const names = new Map<string, string | null>();
    const typed: TypedLine[] = [];
    for (const c of candidates) {
      const pending = c.client_id
        ? await ctx.db
            .query("pending_messages")
            .withIndex("by_conversation_client_id", (q) => q.eq("conversation_id", conv._id).eq("client_id", c.client_id))
            .first()
        : null;
      const provenance = messageProvenance(
        c,
        pending ? { channel: pending.channel, echo_message_id: pending.echo_message_id ? String(pending.echo_message_id) : undefined } : null,
        conv,
      );
      if (provenance === "program") continue;
      const userId = String(provenance === "typed_composer" ? pending!.from_user_id : conv.user_id);
      if (!names.has(userId)) names.set(userId, nameOf(await ctx.db.get(userId as Id<"users">)));
      typed.push({
        conversation_id: String(conv._id),
        short_id: shortIdOf(conv),
        line: c.line,
        message_id: c._id,
        user_id: userId,
        user_name: names.get(userId) ?? null,
        provenance,
        text: c.content,
        created_at: new Date(c.timestamp).toISOString(),
      });
    }
    // Convex values have no undefined, so absent fields are left out.
    const next: ScanState | undefined = cursor
      ? { after: cursor, line, ...(prev ? { prev: JSON.parse(JSON.stringify(prev)) } : {}), ...(held ? { held: JSON.parse(JSON.stringify(held)) } : {}) }
      : undefined;
    return { typed, ...(next ? { state: next } : {}) };
  },
});
