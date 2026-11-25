// The reads behind /cli/sessions/originator (`cast flow asker`): the chain
// from a session up to the one that started its line of work, and every line
// a person typed into the sessions on it, each with its provenance
// (lib/messageProvenance.ts). The route drives them through
// lib/originatorChain.readOriginator. /cli/intent/verify (lib/intentHttp.ts)
// drives citeRun and typedStep through lib/originatorChain.verifyCitation.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import { insertTaskComment } from "./tasks";
import type { Doc, Id } from "./_generated/dataModel";
import { readableConversation, streamMessageRows } from "./conversations";
import { canOwnerOrTeamAccess } from "./privacy";
import { canAccessTask } from "./lib/access";
import { findTaskByRef } from "./taskEvidence";
import { isNonEmptyMessage } from "./lib/conversationBasics";
import type { ScanCursor } from "./lib/conversationRead";
import { commandExpansionName } from "../../web/lib/conversationProcessor";
import { launchedByProgram, mayBeTyped, messageProvenance, queuedTwin, sameWordsKey, typedPart } from "./lib/messageProvenance";
import { walkOriginatorChain, type CardFacts, type ChainLink, type ChainStop, type CiteRun, type TypedLine } from "./lib/originatorChain";
import { verifyApiToken } from "./apiTokens";
import { canReadRun } from "./workflow_runs";
import { cardRef, personAnswersIn, personVerdicts, verdictLabel, type PersonVerdict } from "./lib/taskVerdicts";

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
  /** A person's answers to the decision cards the chain's sessions asked, and to the task's Ship cards. */
  cards: CardLine[];
};

/**
 * A person's answer to a decision card, read beside their typed lines: the card, the session that asked it (when one
 * on the chain did), whether it is one of the task's Ship cards, its question, the answer and its words, and when.
 */
export type CardLine = {
  card: string;
  session_short_id?: string;
  on_task?: true;
  question: string;
  answer: string;
  note?: string;
  user_id: string;
  user_name: string | null;
  created_at: string;
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

/** The most sessions bound to or handing off a task that its chains start from, the newest kept. */
export const TASK_SESSION_ANCHORS = 12;

/**
 * The sessions tied to a task, each one a server-written field, never a name a client passes: the one that filed it
 * (created_from_conversation), those that bound it or handed it off (conversation_ids, which tasks.update records for
 * the session behind a start or a handoff), and those whose handoff comment is on it (a handoff from another
 * workspace leaves only the comment). A session reviewing the task is none of them.
 */
async function taskAnchors(ctx: any, task: Doc<"tasks">): Promise<Conv[]> {
  const handoffs = (await ctx.db.query("task_comments").withIndex("by_task_id", (q: any) => q.eq("task_id", task._id)).collect())
    .filter((c: any) => c.conversation_id && c.comment_type === "review" && HANDOFF_COMMENT.test(c.text))
    .sort((a: any, b: any) => a.created_at - b.created_at)
    .map((c: any) => String(c.conversation_id));
  const worked = [...new Set([...(task.conversation_ids ?? []).map(String), ...handoffs])].slice(-TASK_SESSION_ANCHORS);
  const ids = [...new Set([...(task.created_from_conversation ? [String(task.created_from_conversation)] : []), ...worked])];
  const out: Conv[] = [];
  for (const id of ids) {
    const conv = await ctx.db.get(id as Id<"conversations">);
    if (conv && String(conv.review_of_task_id ?? "") !== String(task._id)) out.push(conv);
  }
  return out;
}

/** The chains up from every session tied to a task (taskAnchors), merged, as far as `userId` may read them. */
async function taskChains(ctx: any, userId: Id<"users">, task: Doc<"tasks">): Promise<{ chain: ChainEntry[]; stopped?: ChainStop }> {
  const chain = new Map<string, ChainEntry>();
  let stopped: ChainStop | undefined;
  for (const anchor of await taskAnchors(ctx, task)) {
    if (chain.has(String(anchor._id))) continue;
    if (!(await canOwnerOrTeamAccess(ctx, userId, anchor))) { stopped ??= "access_denied"; continue; }
    const walk = await walkFrom(ctx, userId, anchor);
    for (const hop of walk.chain) if (!chain.has(hop.conversation_id)) chain.set(hop.conversation_id, hop);
    stopped ??= walk.stopped;
  }
  return { chain: [...chain.values()], ...(stopped ? { stopped } : {}) };
}

/** Who started a run (workflow_runs.user_id), read from the run itself. */
async function starterOf(ctx: any, run: Doc<"workflow_runs">) {
  const row = await ctx.db.get(run.user_id);
  return { starter_id: String(run.user_id), starter_name: nameOf(row), starter_is_bot: !!row?.is_bot };
}

/**
 * The chain from a session to its originator, the chains of the sessions tied to a task when one is named, and who
 * started the run when one is. With a task and no session (a run started from a plain shell on a task whose working
 * sessions have ended), the task's chains are the whole read, and a task no session is tied to is an error.
 */
export const chain = internalQuery({
  args: { api_token: v.string(), conversation_id: v.optional(v.string()), task: v.optional(v.string()), run_id: v.optional(v.string()) },
  handler: async (ctx, args): Promise<(OriginatorHead & Partial<Awaited<ReturnType<typeof starterOf>>>) | { error: string }> => {
    let userId: Id<"users">;
    let start: Conv | null = null;
    if (args.conversation_id !== undefined) {
      const access = await readableConversation(ctx, args.api_token, args.conversation_id);
      if ("error" in access) return { error: access.error ?? "Access denied" };
      userId = access.user._id;
      start = access.conv;
    } else {
      if (!args.task) return { error: "Name a session or a task" };
      const auth = await verifyApiToken(ctx, args.api_token);
      if (!auth) return { error: "Unauthorized" };
      userId = auth.userId as Id<"users">;
    }
    const runId = args.run_id ? ctx.db.normalizeId("workflow_runs", args.run_id) : null;
    const run = runId ? await ctx.db.get(runId) : null;
    if (args.run_id && (!run || !(await canReadRun(ctx, userId, run)))) return { error: `Run ${args.run_id} not found` };
    const head: OriginatorHead = { chain: [], cards: [] };
    if (start) {
      const walk = await walkFrom(ctx, userId, start);
      const author = walk.root.author_user_id ?? walk.root.user_id;
      const authorRow = await ctx.db.get(author);
      head.chain = walk.chain;
      if (walk.stopped) head.stopped = walk.stopped;
      head.originator = {
        conversation_id: String(walk.root._id),
        short_id: shortIdOf(walk.root),
        user_id: String(author),
        user_name: nameOf(authorRow),
        is_bot: !!authorRow?.is_bot,
        launched_by_program: launchedByProgram(walk.root),
      };
    }
    const task = args.task ? await findTaskByRef(ctx, args.task) : null;
    if (args.task) {
      if (!task || !(await canAccessTask(ctx, userId, task))) return { error: `Task ${args.task} not found` };
      head.task = { short_id: task.short_id ?? String(task._id), ...(await taskChains(ctx, userId, task)) };
      if (!start && !head.task.chain.length) return { error: `No session you can read is tied to ${args.task}` };
    }
    // Cards asked in any session on the chain, then the task's Ship cards: one line per card.
    const sessions = new Map([...head.chain, ...(head.task?.chain ?? [])].map((h) => [h.conversation_id, h.short_id]));
    const answers = new Map<string, { v: PersonVerdict; session?: string; on_task?: true }>();
    for (const [conversationId, shortId] of sessions) {
      for (const v of await personAnswersIn(ctx, conversationId as Id<"conversations">)) answers.set(v.ref, { v, session: shortId });
    }
    if (task) for (const v of await personVerdicts(ctx, task._id)) answers.set(v.ref, { ...answers.get(v.ref), v, on_task: true });
    const names = new Map<string, string | null>();
    for (const { v, session, on_task } of answers.values()) {
      if (!names.has(v.user_id)) names.set(v.user_id, nameOf(await ctx.db.get(v.user_id as Id<"users">)));
      head.cards.push({
        card: v.ref, ...(session ? { session_short_id: session } : {}), ...(on_task ? { on_task } : {}),
        question: v.question, answer: v.label, ...(v.note ? { note: v.note } : {}),
        user_id: v.user_id, user_name: names.get(v.user_id) ?? null, created_at: new Date(v.at).toISOString(),
      });
    }
    return run ? { ...head, ...(await starterOf(ctx, run)) } : head;
  },
});

/**
 * What a cited word (`cast flow intent-verify`, /cli/intent/verify) is checked against: who started the run, every session its
 * change came through as the run's own runner may read them, and the newest verdict a person gave on the task's
 * Ship cards. The chain is walked up from two anchors only, both written by the server, not by agents: the session
 * that started the run (spawner_conversation_id) and the one that filed its task (created_from_conversation). Task
 * comments, which any agent can post, name no anchor.
 *
 * The threat this guards against is an honest misread: a model citing a line a person did not type, a quote not on
 * it, another person's word, or a word a later verdict took back. It does not guard against a holder of the
 * starter's token forging a session's environment or links; such a holder can push main anyway.
 */
export const citeRun = internalQuery({
  args: { api_token: v.string(), run_id: v.string() },
  handler: async (ctx, args): Promise<CiteRun | { error: string }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    const runId = ctx.db.normalizeId("workflow_runs", args.run_id);
    const run = runId ? await ctx.db.get(runId) : null;
    if (!auth || !run || String(run.user_id) !== String(auth.userId)) return { error: "Only the run's own runner can check its asker's word" };
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
      ...(task ? { task_id: String(task._id) } : {}),
      chain: [...chain.values()].map(({ conversation_id, short_id }) => ({ conversation_id, short_id })),
      ...(verdict ? { verdict: { ref: verdict.ref, at: verdict.at, ship: verdict.ship, label: verdict.label } } : {}),
    };
  },
});

/** The one line a verified word leaves: on the run's task, for the run's own runner. Nothing on the run itself. */
export const noteIntent = internalMutation({
  args: { api_token: v.string(), run_id: v.string(), text: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    const runId = ctx.db.normalizeId("workflow_runs", args.run_id);
    const run = runId ? await ctx.db.get(runId) : null;
    if (!auth || !run || String(run.user_id) !== String(auth.userId) || !run.task_id) return;
    await insertTaskComment(ctx, run.task_id, { author: "line", text: args.text, comment_type: "progress", conversation_id: run.primary_conversation_id ?? undefined });
  },
});

/** A cited card as verifyCardCitation reads it, for the run's own runner (citeRun's rule). */
export const citedCard = internalQuery({
  args: { api_token: v.string(), run_id: v.string(), card: v.string() },
  handler: async (ctx, args): Promise<CardFacts | null | { error: string }> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    const runId = ctx.db.normalizeId("workflow_runs", args.run_id);
    const run = runId ? await ctx.db.get(runId) : null;
    if (!auth || !run || String(run.user_id) !== String(auth.userId)) return { error: "Only the run's own runner can check its asker's word" };
    const d: any = await ctx.db.query("session_decisions").withIndex("by_short_id", (q) => q.eq("short_id", args.card)).first();
    if (!d) return null;
    return {
      short_id: cardRef(d),
      conversation_id: String(d.conversation_id),
      ...(d.task_id ? { task_id: String(d.task_id) } : {}),
      status: d.status,
      ...(d.answered_by ? { answered_by: { kind: d.answered_by.kind, id: String(d.answered_by.id) } } : {}),
      answer: verdictLabel(d),
      ...(d.answer_text ? { note: String(d.answer_text) } : {}),
      ...(d.resolved_at ? { resolved_at: d.resolved_at } : {}),
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
