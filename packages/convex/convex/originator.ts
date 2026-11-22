// The reads behind /cli/sessions/originator (`cast flow asker`): the chain
// from a session up to the one that started its line of work, and every line
// a person typed into the sessions on it, each with its provenance
// (lib/messageProvenance.ts). The route drives them through
// lib/originatorChain.readOriginator. /cli/workflow-runs/clear with a cite
// drives citeRun and typedStep through lib/originatorChain.verifyCitation.
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
import { launchedByProgram, mayBeTyped, messageProvenance, queuedTwin, sameWordsKey, typedPart } from "./lib/messageProvenance";
import { walkOriginatorChain, type ChainLink, type ChainStop, type CiteRun, type TypedLine } from "./lib/originatorChain";
import { verifyApiToken } from "./apiTokens";
import { canReadRun } from "./workflow_runs";
import { personVerdicts } from "./lib/taskVerdicts";

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
  task?: { short_id: string; chain: ChainEntry[]; stopped?: ChainStop; verdicts: TaskVerdictLine[] };
};

/** A person's verdict on one of the task's Ship cards, read beside their typed lines. */
export type TaskVerdictLine = { card: string; user_id: string; user_name: string | null; answer: string; note?: string; created_at: string };

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

/** The chain of the session that filed a task, as far as `userId` may read it. */
async function filingChain(ctx: any, userId: Id<"users">, task: Doc<"tasks">): Promise<{ chain: ChainEntry[]; stopped?: ChainStop }> {
  const filedIn = task.created_from_conversation ? await ctx.db.get(task.created_from_conversation as Id<"conversations">) : null;
  if (!filedIn) return { chain: [] };
  if (!(await canOwnerOrTeamAccess(ctx, userId, filedIn))) return { chain: [], stopped: "access_denied" };
  const walk = await walkFrom(ctx, userId, filedIn);
  return { chain: walk.chain, ...(walk.stopped ? { stopped: walk.stopped } : {}) };
}

/** Who started a run (workflow_runs.user_id), read from the run itself. */
async function starterOf(ctx: any, run: Doc<"workflow_runs">) {
  const row = await ctx.db.get(run.user_id);
  return { starter_id: String(run.user_id), starter_name: nameOf(row), starter_is_bot: !!row?.is_bot };
}

/** The chain from a session to its originator, a task's filing session's chain when one is named, and who started the run when one is. */
export const chain = internalQuery({
  args: { api_token: v.string(), conversation_id: v.string(), task: v.optional(v.string()), run_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<(OriginatorHead & Partial<Awaited<ReturnType<typeof starterOf>>>) | { error: string }> => {
    const access = await readableConversation(ctx, args.api_token, args.conversation_id);
    if ("error" in access) return { error: access.error ?? "Access denied" };
    const userId = access.user._id;
    const runId = args.run_id ? ctx.db.normalizeId("workflow_runs", args.run_id) : null;
    const run = runId ? await ctx.db.get(runId) : null;
    if (args.run_id && (!run || !(await canReadRun(ctx, userId, run)))) return { error: `Run ${args.run_id} not found` };
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
      const verdicts = await personVerdicts(ctx, task._id);
      const names = new Map<string, string | null>();
      for (const v of verdicts) if (!names.has(v.user_id)) names.set(v.user_id, nameOf(await ctx.db.get(v.user_id as Id<"users">)));
      head.task = {
        short_id: task.short_id ?? String(task._id),
        ...(await filingChain(ctx, userId, task)),
        verdicts: verdicts.map((v) => ({
          card: v.ref, user_id: v.user_id, user_name: names.get(v.user_id) ?? null, answer: v.label, ...(v.note ? { note: v.note } : {}),
          created_at: new Date(v.at).toISOString(),
        })),
      };
    }
    return run ? { ...head, ...(await starterOf(ctx, run)) } : head;
  },
});

/**
 * What a cited clear (`cast workflow clear --cite`) is checked against: who started the run, every session its
 * change came through as the run's own runner may read them, and the newest verdict a person gave on the task's
 * Ship cards. The chain is walked up from two anchors only, both written by the server, not by agents: the session
 * that started the run (spawner_conversation_id) and the one that filed its task (created_from_conversation). Task
 * comments, which any agent can post, name no anchor.
 *
 * The threat this guards against is an honest misread: a model citing a line a person did not type, a quote not on
 * it, another person's word, or a word a later verdict took back. It does not guard against a holder of the
 * starter's token forging a session's environment or links; such a holder can push main anyway (clearForMergeCore).
 */
export const citeRun = internalQuery({
  args: { api_token: v.string(), run_id: v.string() },
  handler: async (ctx, args): Promise<CiteRun | { error: string }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    const runId = ctx.db.normalizeId("workflow_runs", args.run_id);
    const run = runId ? await ctx.db.get(runId) : null;
    if (!auth || !run || String(run.user_id) !== String(auth.userId)) return { error: "Only the run's own runner clears it to land" };
    const task = run.task_id ? await ctx.db.get(run.task_id) : null;
    const spawner = run.spawner_conversation_id ? await ctx.db.get(run.spawner_conversation_id) : null;
    const chain = new Map<string, { conversation_id: string; short_id: string }>();
    if (spawner && (await canOwnerOrTeamAccess(ctx, run.user_id, spawner))) {
      for (const hop of (await walkFrom(ctx, run.user_id, spawner)).chain) chain.set(hop.conversation_id, hop);
    }
    if (task) for (const hop of (await filingChain(ctx, run.user_id, task)).chain) chain.set(hop.conversation_id, hop);
    const starter = await starterOf(ctx, run);
    const [verdict] = task ? await personVerdicts(ctx, task._id) : [];
    return {
      ...starter,
      chain: [...chain.values()].map(({ conversation_id, short_id }) => ({ conversation_id, short_id })),
      ...(verdict ? { verdict: { ref: verdict.ref, at: verdict.at, ship: verdict.ship, label: verdict.label } } : {}),
    };
  },
});

type Row = { role: string; content?: string; timestamp: number };
type Candidate = { _id: string; line: number; content: string; client_id?: string; from_user_id?: string; timestamp: number };
/** Where a scan resumes: the cursor, the last line numbered, the row before it, and a candidate held until its next neighbour shows it is not a slash command's body. */
type ScanState = { after?: ScanCursor; line: number; prev?: Row; held?: Candidate };

const PREV_CHARS = 2_000;

// The queue rows a terminal line is checked against: those created from a day before it to an hour after (its echo
// can lag its send, ct-52622), at most QUEUE_WINDOW_ROWS, and at most QUEUE_STEP_BYTES of their words across one
// scan step, so a long-lived session's queue never pushes a step past Convex's per-query read limit beside the
// messages the step streams.
const QUEUE_BEFORE_MS = 24 * 3_600_000;
const QUEUE_AFTER_MS = 3_600_000;
const QUEUE_WINDOW_ROWS = 50;
const QUEUE_STEP_BYTES = 2_000_000;

/**
 * The words of the session's queue rows around `at` (lib/messageProvenance.sameWordsKey), or null when they cannot
 * all be read: more rows than the window holds, or the step's byte budget already spent by earlier lines.
 */
export async function queuedNear(db: any, conversationId: Id<"conversations">, at: number, budget: { bytes: number }): Promise<Set<string> | null> {
  if (budget.bytes <= 0) return null;
  const rows = await db
    .query("pending_messages")
    .withIndex("by_conversation_created", (q: any) => q.eq("conversation_id", conversationId).gte("created_at", at - QUEUE_BEFORE_MS).lte("created_at", at + QUEUE_AFTER_MS))
    .take(QUEUE_WINDOW_ROWS + 1);
  if (rows.length > QUEUE_WINDOW_ROWS) return null;
  const keys = new Set<string>();
  for (const row of rows) {
    budget.bytes -= row.content.length;
    const key = sameWordsKey(row.content);
    if (key) keys.add(key);
  }
  return keys;
}

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
    const budget = { bytes: QUEUE_STEP_BYTES };
    for (const c of candidates) {
      const pending = c.client_id
        ? await ctx.db
            .query("pending_messages")
            .withIndex("by_conversation_client_id", (q) => q.eq("conversation_id", conv._id).eq("client_id", c.client_id))
            .first()
        : null;
      const row = pending ? { channel: pending.channel, typed_text: pending.typed_text, echo_message_id: pending.echo_message_id ? String(pending.echo_message_id) : undefined } : null;
      // A line that would read as typed at the terminal is checked against what the queue sent around it; a window
      // too full or a step past its read budget cannot be checked, and reads as program.
      let provenance = messageProvenance(c, row, conv);
      if (provenance === "typed_local") {
        const near = await queuedNear(ctx.db, conv._id, c.timestamp, budget);
        provenance = messageProvenance(c, row, conv, !near || queuedTwin(c.content, near));
      }
      const words = typedPart(c.content, provenance, row);
      if (provenance === "program" || !words) continue;
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
        text: words,
        // When the person said it: a composer line's submit (its queue row), not when a queued send reached the agent.
        created_at: new Date(provenance === "typed_composer" ? pending!.created_at : c.timestamp).toISOString(),
      });
    }
    // Convex values have no undefined, so absent fields are left out.
    const next: ScanState | undefined = cursor
      ? { after: cursor, line, ...(prev ? { prev: JSON.parse(JSON.stringify(prev)) } : {}), ...(held ? { held: JSON.parse(JSON.stringify(held)) } : {}) }
      : undefined;
    return { typed, ...(next ? { state: next } : {}) };
  },
});
