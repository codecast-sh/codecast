// Close advice (`cast advise-close <session>`): whether closing a quiet session
// loses anything. close, or needs_input naming what the person must do first.
// It proposes and never acts: nothing here writes. After a Close or Kill in the
// app, adviseAfterClose asks the model the same of the sessions the inbox did
// not file under Needs You, so the undo bar can warn when one asked something.
//
// Close is dormancy, not retirement (contracts/closeKind): in-flight work is
// set aside to finish, and a trigger or a park brings a stopped session back.
// Advice is the inbox's placement of this one session (classifyNamedWorkState,
// the inbox's own classifier over the same inputs) plus what Close itself
// does (the Close facts):
//   - a question or permission prompt waiting on the person, in it or its
//     group: needs_input;
//   - the inbox files it needs_input: its declared block (declaredBlockHolds)
//     with the ask the pin names, else a settle verdict that its stop asks,
//     else the model (the inbox's fallthrough is "no verdict", the model's
//     job), even while work is in flight: a queued message on a dead daemon
//     or a loop the person spoke over still waits on the person;
//   - otherwise work still in flight: close, which sets it aside to finish;
//   - the inbox rests it dormant: close, when Close keeps the wake that brings
//     it back; a claim Close keeps nothing for goes to the model;
//   - the inbox files it done: close on a current settle "done" or the
//     person's own Done; needs_input on a current settle that asks; else the
//     model (below);
//   - anything else (working, idle): the model.
// One departure, on purpose: the inbox files a session Done on the agent's own
// done (its pin or its daemon status), and advice does not close on that alone.
// A done pin cannot vouch for its last message (a session pinned done while
// its last message asked two questions belonged in Needs You), and Close would
// hide that ask; the agent's `cast state` after its stop also leaves the settle
// verdict stale. So only the classifier's or the model's reading of that
// message closes a Done session, and a current settle verdict that it asks
// gives needs_input.
import { v } from "convex/values";
import { agentAnswersRow, commandsSession, declaredBlockHolds, isSettleVerdictCurrent, threadStateAskRow, threadStateCardLine, threadStateRows } from "@codecast/shared/contracts";
import { isArmedInjectTrigger } from "@codecast/shared/contracts/armedTrigger";
import { AFTER_CLOSE_CALL_MS, AFTER_CLOSE_MAX, closeEffect, closeFactsFrom, closeKindOf, closeSetsAside, killFacts, type AfterCloseResult, type CloseAdvice, type CloseAdviceResult, type CloseFacts } from "@codecast/shared/contracts/closeKind";
import { rowPinPredatesTurn } from "@codecast/shared/contracts/inboxPlacement";
import { action, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { canAccessConversation, canAccessPlan, canAccessTask, workspaceForConversation, workspaceForResource, workspacesMatch } from "./lib/access";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { getAuthenticatedUserId } from "./permissions";
import { CHEAP_MODEL, type SurfaceRequest } from "./lib/anthropic";
import { cascadeTakesDown, closeInFlightOnServer } from "./lib/closeAside";
import { withInboxOwners } from "./lib/inboxOwners";
import { classifyNamedWorkState } from "./conversations";
import { userRestOf } from "./inboxFilters";
import { teamFeatureOffMessage, workspaceHasFeature } from "./lib/teamFeatureGuard";
import { runModelCall, sessionCallBudget, type SessionCallBudget } from "./modelCalls";
import { parseSettleVerdict, shapeSettleTail, SETTLE_TAIL_MESSAGES, type SettleTailMessage, type SettleVerdict } from "./idleSummary";

// ── The facts the server can verify ─────────────────────────────────────────

/** What Close itself settles: a question waiting on the person
 *  (needs_input), or a close that keeps what brings it back (in flight set
 *  aside, a trigger, a park, a flow run), in the Close tooltip's own words.
 *  Null when Close keeps nothing: it would only stop it. */
export function adviceFromFacts(f: CloseFacts): CloseAdvice | null {
  const kind = closeKindOf(f);
  if (kind === "awaiting") {
    const reason = f.inFlight === "nested_awaiting" ? "Answer the question or permission prompt one of its agents waits on" : "Answer its open question or permission prompt";
    return { verdict: "needs_input", reason, decided_by: "facts" };
  }
  // Nothing will wake it: a role's own session comes back only on a message, like any other.
  if (kind === "clears" || (kind === "keeps_triggers" && f.triggers === 0)) return null;
  return { verdict: "close", reason: closeEffect(f), decided_by: "facts" };
}

/** The advice from the inbox's placement of the session (`state`, and the
 *  trusted status it read) and the Close facts; null for the model. */
function adviceFromPlacement(state: string, trustedStatus: string | null, f: CloseFacts, conv: any, settle: SettleVerdict | null): CloseAdvice | null {
  const fromFacts = adviceFromFacts(f);
  if (fromFacts?.verdict === "needs_input") return fromFacts;
  const asks: CloseAdvice = { verdict: "needs_input", reason: "Read its last message: it asks something of you", decided_by: "settle" };
  // The inbox's needs_input outranks work in flight (the header says why).
  if (state === "needs_input") return adviceFromDeclaredBlock(trustedStatus, conv) ?? (settle === "needs_input" ? asks : null);
  if (closeSetsAside(f)) return fromFacts;
  switch (state) {
    case "dormant": return fromFacts;
    case "done":
      // The person filed it Done themselves: closing is theirs to do.
      if (userRestOf(conv) === "done") return { verdict: "close", reason: "You filed it done", decided_by: "facts" };
      // The departure in the header: a done pin alone never closes.
      if (settle === "needs_input") return asks;
      if (settle !== "done") return null;
      return { verdict: "close", reason: conv.idle_summary ?? fromFacts?.reason ?? "Its last turn finished with nothing asked", decided_by: "settle" };
    default: return null;
  }
}

const TRIGGER_SCAN = 50;

/** The Close facts of one conversation, from the database, by the shared
 *  rules the web tooltip reads the row by (contracts/closeKind closeFactsFrom),
 *  with its managed row and the nested group the Close scan read: that read
 *  feeds the children, and the managed row the dormant claim. */
async function closeFactsOnServer(ctx: { db: any }, conv: any, now: number): Promise<{ facts: CloseFacts; managed: any; group: any[] }> {
  const [{ inFlight, group }, managed, injecting, run] = await Promise.all([
    closeInFlightOnServer(ctx, conv, now),
    ctx.db.query("managed_sessions").withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id)).first(),
    // Newest first: a long-lived session's oldest triggers are long finished.
    ctx.db.query("agent_tasks").withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", conv._id)).order("desc").take(TRIGGER_SCAN),
    conv.workflow_run_id && !conv.is_workflow_sub ? ctx.db.get(conv.workflow_run_id) : null,
  ]);
  const facts = closeFactsFrom(conv, {
    inFlight,
    armedTriggers: injecting.filter(isArmedInjectTrigger).length,
    lastHeartbeat: managed?.last_heartbeat ?? null,
    runLive: !!run && (run.status === "running" || run.status === "pending"),
    inProcessRun: run?.run_kind === "workflow",
    // The members its stop takes down, by the cascade's own rule (the web's closeTakesDownOf).
    takesDown: group.filter((c: any) => cascadeTakesDown(c, "inbox_dismissed_at", { forceKill: true, close: true })).length,
  }, now);
  return { facts, managed, group };
}

// ── The inbox's placement, the agent's own word, and the settle verdict ──────

/** The settle classifier's verdict on the session's last stop, when it was
 *  recorded after the last activity (isSettleVerdictCurrent), or null. That
 *  covers the latest turn too: the only write of last_turn_at (lib/userSend
 *  turnOpenerPatch) rides a message patch that moves updated_at to at least it. */
function currentSettleVerdict(conv: any): SettleVerdict | null {
  if (!isSettleVerdictCurrent({ settle_verdict_at: conv.settle_verdict_at, updated_at: conv.updated_at ?? 0 })) return null;
  return parseSettleVerdict(conv.settle_verdict);
}

/** Its own declared block, by the inbox's rule (declaredBlockHolds over the
 *  trusted status placement read and the pin as the row holds it), with the
 *  ask the pin names (threadStateAskRow: its `You:` or older `Blocked:` line,
 *  as the card shows it), else its headline. */
function adviceFromDeclaredBlock(trustedStatus: string | null, conv: any): CloseAdvice | null {
  if (!declaredBlockHolds({ agentStatus: trustedStatus ?? undefined, declaredStatus: conv.thread_state_status ?? null })) return null;
  const pinText: string = conv.thread_state ?? "";
  const rows = threadStateRows(pinText);
  const line = threadStateCardLine(pinText, rows);
  return { verdict: "needs_input", reason: threadStateAskRow(rows) ? line : `Answer its pinned status: ${line || "it says it is blocked"}`, decided_by: "pin" };
}

// ── The model, for the rest ─────────────────────────────────────────────────

export type SessionFacts = {
  now: number;
  /** The session's newest activity (conversations.updated_at). */
  lastActivityAt: number;
  title: string | null;
  /** The agent's own pinned status (`cast state`). */
  pin: { text: string; status: string | null; at: number; predatesTurn: boolean } | null;
  /** The settle classifier's read of the last settle, if it still describes it. */
  settle: { verdict: string; summary: string | null } | null;
  /** What a close keeps that brings it back, in the Close tooltip's words
   *  ("stops it, runs its trigger out of sight, back when it's done or needs you"), or null when
   *  closing keeps nothing (adviceFromFacts gives no close). */
  closeKeeps: string | null;
  /** It declared itself dormant (pin or status). */
  dormantClaim: boolean;
  task: { title: string; status: string } | null;
  plan: { title: string; status: string } | null;
  /** Its spawned and Task children the caller can read, newest first. */
  children: Array<{ title: string; status: string; pin: string | null; updatedAt: number }>;
  git: { branch: string | null; dirty: boolean | null; ahead: number | null; behind: number | null; at: number } | null;
};

function ago(now: number, at: number): string {
  const m = Math.max(0, Math.round((now - at) / 60_000));
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function renderFacts(f: SessionFacts): string {
  const lines: string[] = [`Now: ${new Date(f.now).toISOString()}`, `Last activity: ${ago(f.now, f.lastActivityAt)}`];
  if (f.title) lines.push(`Title: ${f.title}`);
  lines.push(f.closeKeeps ? `Armed wakes: closing keeps one: ${f.closeKeeps}` : "Armed wakes: none (no trigger, loop, background work, running subagent, queued message or parked wake)");
  if (f.pin) {
    const when = f.pin.predatesTurn ? "written before the latest turn, so older than the transcript's end" : "current";
    lines.push(`Pinned status (${f.pin.status ?? "no status"}, ${ago(f.now, f.pin.at)}, ${when}): ${f.pin.text}`);
  } else lines.push("Pinned status: none");
  if (f.dormantClaim) lines.push(f.closeKeeps ? "It declared itself dormant." : "It declared itself dormant, but none of the wakes above is armed.");
  if (f.settle) lines.push(`Settle classifier at its last stop: ${f.settle.verdict}${f.settle.summary ? ` — ${f.settle.summary}` : ""}`);
  lines.push(f.task ? `Task it holds: ${f.task.title} (${f.task.status})` : "Task it holds: none");
  if (f.plan) lines.push(`Plan it is bound to: ${f.plan.title} (${f.plan.status})`);
  if (f.children.length) {
    lines.push(`Child sessions (${f.children.length}):`);
    for (const c of f.children) lines.push(`- ${c.title} (${c.status}, ${ago(f.now, c.updatedAt)})${c.pin ? `: ${c.pin}` : ""}`);
  }
  if (f.git) {
    const parts = [
      f.git.branch ? `branch ${f.git.branch}` : null,
      f.git.dirty == null ? null : f.git.dirty ? "uncommitted changes" : "clean tree",
      f.git.ahead ? `${f.git.ahead} commits not pushed` : null,
      f.git.behind ? `${f.git.behind} behind its upstream` : null,
    ].filter(Boolean);
    lines.push(`Checkout (${ago(f.now, f.git.at)}; other sessions may share it): ${parts.join(", ") || "no state"}`);
  }
  return lines.join("\n");
}

export function buildCloseAdvicePrompt(facts: SessionFacts, tail: SettleTailMessage[]): string {
  const transcript = tail
    .map((m) => {
      if (m.role === "note") return `Note: ${m.content}`;
      const who = m.role === "assistant" ? "Agent" : "Person";
      return m.isFinal ? `${who} [FINAL MESSAGE]: ${m.content}` : `${who}: ${m.content}`;
    })
    .join("\n\n");

  return `A person is clearing quiet agent sessions out of their inbox and wants to know whether closing this one loses anything. Closing stops the agent and takes the session out of view; a person's message brings it back, and a wake runs it out of sight until it reports, but nothing reminds the person of it. Read the facts and the end of its transcript, then decide.

${facts.closeKeeps ? "Closing keeps a wake the system verified (the facts name it), so a line in the transcript about checking back or waiting may have it behind it. Decide whether its end still owes the person something." : "Nothing the system can see will wake this session: the facts list no armed wake. So a line in the transcript about checking back, watching or waiting for something has nothing behind it."}

Reply with exactly two lines:
VERDICT: <close | needs_you>
REASON: <one sentence>

- close: what was asked for is finished, answered or delivered, or the person dropped it; nobody is waiting on the agent and the agent is waiting on nobody; and its final words only report what was done: they ask nothing, offer nothing, suggest nothing and hand the person nothing to do. Work that could always go one more round (tuning, polishing, optimizing) is close once it reached a reported stopping point that offers no next round. REASON says what it finished.
- needs_you: closing would bury something the person still owes or would want to know: a question the work cannot finish without, final words (or a pin) that ask the person to do anything, even outside the session ("reopen Chrome"), or that name more work, even optional, as a question, an offer or an aside ("want me to file both?", "tell me if you want either", "reopen me if…", suggested follow-ups, an offer to take over another session's work), options or a recommendation to choose from, an item handed to them, a blocker only they can clear, a plan or a diagnosis of a defect nobody is fixing that awaits their go-ahead, work that stopped partway with no report, or a watch the agent promised that nothing will now carry out. REASON is the action for the person, starting with a verb.

Weigh the facts with the transcript. The final message usually decides; a pinned status written after the transcript's end is the agent's own latest word. A task still open or uncommitted changes are reasons to look closer, not verdicts: a shared checkout is often dirty with other sessions' work, and a delivered audit leaves its task to the person's tidying. When in doubt choose needs_you: a finished session kept costs the person a glance, a closed one that still owed them something is lost.

Never write "please", "the user" or "you". No quotes or JSON.

Facts:
${renderFacts(facts)}

Transcript (newest last):
${transcript}`;
}

export function closeAdviceRequest(facts: SessionFacts, tail: SettleTailMessage[]): SurfaceRequest {
  return { model: CHEAP_MODEL, max_tokens: 160, prompt: buildCloseAdvicePrompt(facts, tail) };
}

/** The model's two lines, or null when no verdict parses ("keep" is no
 *  verdict). The prompt asks for needs_you, the word it was graded with, and
 *  this maps it to needs_input. */
export function parseCloseAdvice(raw: string): CloseAdvice | null {
  const text = raw.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Markdown emphasis and code marks around the label and the word ("**VERDICT:** `close`.") carry nothing.
  const verdictWord = text.match(/^[\s*]*verdict[\s*]*:[\s*]*(.+)$/im)?.[1]?.replace(/[*`]/g, "").trim().toLowerCase().replace(/[.!,;:]+$/, "").trim().replace(/[\s-]+/g, "_");
  // A reply cut short ("needs_v") still names its side.
  const needs = !!verdictWord?.startsWith("needs");
  if (verdictWord !== "close" && !needs) return null;
  const reason = text.match(/^[\s*]*reason[\s*]*:[\s*]*(.+)$/im)?.[1]?.trim() ?? "";
  return { verdict: needs ? "needs_input" : "close", reason, decided_by: "model" };
}

// ── Gathering, from the database ─────────────────────────────────────────────

const CHILDREN_SHOWN = 8;
const SPAWNED_SCAN = 50;

/** Its nested group, as the in-flight scan read it, and the sessions it
 *  spawned outside it, newest first. */
async function childrenOf(ctx: { db: any }, conv: any, group: any[]): Promise<any[]> {
  const spawned = await ctx.db.query("conversations").withIndex("by_spawned_by", (q: any) => q.eq("spawned_by_conversation_id", conv._id)).order("desc").take(SPAWNED_SCAN);
  const seen = new Set(group.map((c: any) => String(c._id)));
  return [...group, ...spawned.filter((c: any) => !seen.has(String(c._id)))]
    .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/** Whether the caller may read one document the prompt would show. */
export type CanRead = (table: "conversations" | "tasks" | "plans", doc: any) => Promise<boolean>;

/** A child, task or plan the session's model call may carry: one in the
 *  session's own access workspace. The vendor gate scopes the call to the
 *  session. For a child session that is not enough: the gate classifies a
 *  session's data by its team_id too (lib/vendorGuard), so a child filed under
 *  another team is left out. A task or plan is classified by its workspace
 *  alone (managedPolicy policyTeamOf), which the match already covers. */
function inParentWorkspace(parent: any, table: "conversations" | "tasks" | "plans", doc: any): boolean {
  const parentWs = workspaceForConversation(parent);
  if (table !== "conversations") return workspacesMatch(parentWs, workspaceForResource(doc));
  return workspacesMatch(parentWs, workspaceForConversation(doc)) && String(parent.team_id ?? "") === String(doc.team_id ?? "");
}

/** The facts of one conversation (pure reads). `canRead` admits each child,
 *  task and plan whose title the caller may see. */
export async function gatherCloseAdviceInput(ctx: { db: any }, conv: any, now: number, canRead: CanRead): Promise<
  { advice: CloseAdvice } | { facts: SessionFacts; tail: SettleTailMessage[] }
> {
  // The header's rules: the inbox's placement (its own classifier) plus what Close itself does.
  const [closed, placed] = await Promise.all([closeFactsOnServer(ctx, conv, now), classifyNamedWorkState(ctx, conv, now)]);
  const decided = adviceFromPlacement(placed.state, placed.agentStatus, closed.facts, conv, currentSettleVerdict(conv));
  if (decided) return { advice: decided };
  return modelInputOf(ctx, conv, now, canRead, closed);
}

/** What the model reads of one conversation, with the Close facts and the
 *  nested group the Close scan read. */
async function modelInputOf(ctx: { db: any }, conv: any, now: number, canRead: CanRead, closed: { facts: CloseFacts; managed: any; group: any[] }): Promise<{ facts: SessionFacts; tail: SettleTailMessage[] }> {
  const { facts: closeFacts, managed, group } = closed;
  const settle = currentSettleVerdict(conv);
  // What the prompt says of its own word: an older pin is not its word on the transcript's end (rowPinPredatesTurn).
  const predatesTurn = rowPinPredatesTurn({ last_turn_at: conv.last_turn_at, thread_state_at: conv.thread_state_at, last_user_message_at: conv.last_user_message_at });
  // Advice's own declared-dormant rule, deliberately looser than the inbox's (rowWakeInputs), so more goes to the model.
  const dormantClaim = managed?.agent_status === "dormant" || (!predatesTurn && conv.thread_state_status === "dormant");
  const kept = adviceFromFacts(closeFacts);

  const [children, task, plan, newestFirst] = await Promise.all([
    childrenOf(ctx, conv, group),
    conv.active_task_id ? ctx.db.get(conv.active_task_id) : null,
    conv.active_plan_id ? ctx.db.get(conv.active_plan_id) : null,
    ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
      .order("desc")
      .take(SETTLE_TAIL_MESSAGES),
  ]);
  const shown: any[] = [];
  for (const c of children) {
    if (shown.length === CHILDREN_SHOWN) break;
    if (!c.inbox_killed_at && inParentWorkspace(conv, "conversations", c) && await canRead("conversations", c)) shown.push(c);
  }
  const showWork = async (table: "tasks" | "plans", doc: any) => !!doc && inParentWorkspace(conv, table, doc) && await canRead(table, doc);
  const [taskShown, planShown] = await Promise.all([showWork("tasks", task), showWork("plans", plan)]);
  const facts: SessionFacts = {
    now,
    lastActivityAt: conv.updated_at ?? now,
    title: conv.title ?? null,
    pin: conv.thread_state
      ? {
          text: conv.thread_state,
          status: conv.thread_state_status ?? null,
          at: conv.thread_state_at ?? 0,
          predatesTurn,
        }
      : null,
    settle: settle ? { verdict: settle, summary: conv.idle_summary ?? null } : null,
    closeKeeps: kept?.verdict === "close" ? kept.reason : null,
    dormantClaim,
    task: taskShown ? { title: task.title, status: task.status } : null,
    plan: planShown ? { title: plan.title, status: plan.status } : null,
    children: shown.map((c: any) => ({ title: c.title ?? "untitled", status: c.thread_state_status ?? (c.status === "completed" ? "finished" : "open"), pin: c.thread_state ?? null, updatedAt: c.updated_at ?? 0 })),
    git: conv.git_state_at
      ? { branch: conv.git_branch ?? null, dirty: conv.git_dirty ?? null, ahead: conv.git_ahead ?? null, behind: conv.git_behind ?? null, at: conv.git_state_at }
      : null,
  };
  return { facts, tail: shapeSettleTail(newestFirst) };
}

export const FEATURE = "close_advice" as const;

/** What the model call needs. */
type ModelInput = { conversation_id: string; facts: SessionFacts; tail: SettleTailMessage[]; budget: SessionCallBudget };

type CloseAdviceInput = { short_id: string; conversation_id: string } & (
  | { off: "team" | "personal" }
  | { advice: CloseAdvice }
  | ModelInput
);

/** The read rule of the signed-in caller (or the token's) over the session
 *  and what its prompt shows; null when nobody is signed in. */
async function readerOf(ctx: any, apiToken?: string): Promise<CanRead | null> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) return null;
  return (table, doc) =>
    table === "tasks" ? canAccessTask(ctx, userId, doc) : table === "plans" ? canAccessPlan(ctx, userId, doc) : canAccessConversation(ctx, userId, doc);
}

const featureOn = (ctx: any, conv: any) => workspaceHasFeature(ctx, { team_id: conv.team_id, user_id: conv.user_id }, FEATURE);

export const closeAdviceInput = internalQuery({
  args: { session: v.string(), api_token: v.optional(v.string()), now: v.number() },
  handler: async (ctx, args): Promise<CloseAdviceInput> => {
    const canRead = await readerOf(ctx, args.api_token);
    if (!canRead) throw new Error("Not authenticated");
    const conv: any = await findConversationByAnyRefWhere(ctx, args.session, (c: any) => canRead("conversations", c));
    if (!conv) throw new Error(`No session found for "${args.session}"`);
    const ids = { short_id: conv.short_id ?? String(conv._id).slice(0, 7), conversation_id: String(conv._id) };
    if (!(await featureOn(ctx, conv))) return { ...ids, off: conv.team_id ? "team" : "personal" };
    const gathered = await gatherCloseAdviceInput(ctx, conv, args.now, canRead);
    if ("advice" in gathered) return { ...ids, ...gathered };
    return { ...ids, ...gathered, budget: await sessionCallBudget(ctx, conv) };
  },
});

/** `cast advise-close` waits on its one call; the app's after-close calls stop sooner (AFTER_CLOSE_CALL_MS). */
const ADVICE_TIMEOUT_MS = 15_000;

/** The one model call, behind the vendor gate for the session and the caller's token. A workspace that keeps a
 *  budget pays from it; with none, the call is codecast's own and records nothing (runModelCall `budgeted`). */
async function adviceFromModel(ctx: any, input: ModelInput, timeoutMs: number, apiToken?: string, deadline?: number): Promise<{ advice: CloseAdvice } | { error: string }> {
  const request = closeAdviceRequest(input.facts, input.tail);
  const r = await runModelCall(ctx, input.budget.scope, "judge", { model: request.model, prompt: request.prompt, max_tokens: request.max_tokens, output: "text" }, "Close advice", timeoutMs, {
    budgeted: input.budget.budgeted,
    content: { conversationId: input.conversation_id, apiToken: apiToken || undefined },
    deadline,
  });
  if (!r.ok) return { error: r.error };
  const advice = parseCloseAdvice(r.text);
  return advice ? { advice } : { error: "the model gave no verdict" };
}

/** `cast advise-close <session>`: the advice for one session the caller can read. */
export const adviseClose = action({
  args: { session: v.string(), api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<CloseAdviceResult> => {
    const input: CloseAdviceInput = await ctx.runQuery(internal.closeAdvice.closeAdviceInput, { ...args, now: Date.now() });
    const short_id = input.short_id;
    if ("off" in input) return { short_id, off: input.off, message: teamFeatureOffMessage(FEATURE) };
    if ("advice" in input) return { short_id, advice: input.advice };
    return { short_id, ...(await adviceFromModel(ctx, input, ADVICE_TIMEOUT_MS, args.api_token)) };
  },
});

// ── After a Close or Kill in the app ────────────────────────────────────────

type AfterCloseInput = { skip: true } | { close: true } | ModelInput;

const gestureArg = v.union(v.literal("close"), v.literal("kill"));

/** One closed session's model input; close for a Close of a turn still
 *  running; or skip: one the caller does not run or
 *  own (commandsSession, the app's own "your sessions" rule: a teammate's
 *  team-visible session is theirs to be asked about), the feature off for its
 *  workspace, a session whose waits an agent owner answers (the owners
 *  model files it "With <owner>", agentAnswersRow), or one with no messages
 *  to read (nothing it said can have asked anything).
 *  The facts are what the gesture leaves, on purpose, whether or not its
 *  write has landed (the app asks beside the gesture, and the phone holds a
 *  Kill behind its bar): a Kill cancels its triggers and wakes (killFacts), so
 *  a promise to check back has nothing behind it, which is what the warning
 *  is for; a Close keeps its wake. A current settle "done" never stands in for
 *  the model: a verdict made under an older settle prompt is still current,
 *  and those are the rows this net is for. */
export const afterCloseInput = internalQuery({
  args: { session: v.string(), gesture: gestureArg, now: v.number() },
  handler: async (ctx, args): Promise<AfterCloseInput> => {
    const userId = await getAuthenticatedUserId(ctx);
    const canRead = await readerOf(ctx);
    const conv: any = canRead && (await findConversationByAnyRefWhere(ctx, args.session, (c: any) => canRead("conversations", c)));
    if (!conv || !commandsSession(conv, userId) || !(await featureOn(ctx, conv)) || agentAnswersRow(await withInboxOwners(ctx, conv))) return { skip: true };
    const closed = await closeFactsOnServer(ctx, conv, args.now);
    // A Close of a turn still running sets it aside: it has asked nothing yet, so there is nothing to warn about
    // (a tail cut mid tool call would read as work stopped partway). Any other in-flight reason (a background task,
    // a queued message, a loop) can follow a turn that ended with an ask, so it still goes to the model.
    if (args.gesture === "close" && closed.facts.inFlight === "live") return { close: true };
    if (args.gesture === "kill") closed.facts = killFacts(closed.facts, !!conv.persistent);
    const { facts, tail } = await modelInputOf(ctx, conv, args.now, canRead!, closed);
    // A Kill stopped it: a transcript that ends mid tool call is the person's stop, not work left partway (its note
    // goes). A Close only sets it aside, so work it halted mid-call is still unfinished.
    const shown = args.gesture === "kill" ? tail.filter((m) => m.role !== "note") : tail;
    if (!shown.some((m) => m.role !== "note" && m.content.trim())) return { skip: true };
    return { conversation_id: String(conv._id), facts, tail: shown, budget: await sessionCallBudget(ctx, conv) };
  },
});

/** After the person Closes or Kills (`gesture`) sessions in the app: whether each one
 *  still asked them something. The client sends only the sessions it did not
 *  file under Needs You (its own inbox placement, from before the gesture),
 *  and the server trusts that: it decides only whether a gated, budgeted model
 *  call runs on a session the caller runs or owns. The first AFTER_CLOSE_MAX are
 *  advised, together, against one deadline AFTER_CLOSE_CALL_MS from the
 *  action's start, so the answer lands while the app still waits: a session
 *  not done by then, an error or no verdict is "close" for it (no warning),
 *  never a thrown action. Past the deadline its call takes no budget hold and
 *  stops its fetch, and a hold it took settles through the scheduler
 *  (withinBudget): the action then waits only for that bookkeeping (at most a
 *  budget write already in flight), so it never returns with a hold nobody
 *  will settle. */
export const adviseAfterClose = action({
  args: { sessions: v.array(v.string()), gesture: gestureArg },
  handler: async (ctx, args): Promise<{ results: AfterCloseResult[] }> => {
    const now = Date.now();
    const deadline = now + AFTER_CLOSE_CALL_MS;
    const advise = async (session: string): Promise<AfterCloseResult> => {
      try {
        const input: AfterCloseInput = await ctx.runQuery(internal.closeAdvice.afterCloseInput, { session, gesture: args.gesture, now });
        if ("skip" in input) return { session, verdict: "skip" };
        if ("close" in input) return { session, verdict: "close" };
        const out = await adviceFromModel(ctx, input, AFTER_CLOSE_CALL_MS, undefined, deadline);
        if ("advice" in out && out.advice.verdict === "needs_input") return { session, verdict: "needs_you", reason: out.advice.reason };
      } catch {
        // Fall through: no warning.
      }
      return { session, verdict: "close" };
    };
    // One result per session, however often it was sent: a repeat would buy another model call.
    const sessions = [...new Set(args.sessions)];
    const work = sessions.slice(0, AFTER_CLOSE_MAX).map(advise);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), AFTER_CLOSE_CALL_MS); });
    const decided = await Promise.all(work.map(async (w, i): Promise<AfterCloseResult> => {
      const r = await Promise.race([w, late]);
      return r === "late" ? { session: sessions[i]!, verdict: "close" } : r;
    }));
    clearTimeout(timer);
    await Promise.all(work);
    return { results: [...decided, ...sessions.slice(AFTER_CLOSE_MAX).map((session): AfterCloseResult => ({ session, verdict: "skip" }))] };
  },
});
