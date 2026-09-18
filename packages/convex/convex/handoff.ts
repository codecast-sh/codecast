// `cast handoff --to <agent>` / the web's "Hand off to…": continue a session's
// work in a NEW session on another agent or model, linked both ways.
//
// One action does the whole thing, so the CLI (/cli/handoff) and the web (an
// ordinary authenticated action call) share it:
//   1. read the source: its facts, pinned state, bound task/plan, transcript
//   2. ask Haiku for a brief (goal, decisions, verification, questions, steps)
//   3. compose the new session's first prompt (shared composeHandoffPrompt)
//   4. spawn through createSessionFromCli with handoff_from_session, which
//      births the child linked, patches the source, binds the task/plan and
//      pins the source's state as done — all in that one mutation
//
// The brief is a best effort: when the model key is missing or the call fails,
// the prompt still ships with a fallback brief built from the pinned state and
// the last assistant message, and the response says so (brief_source).

import { action, internalQuery } from "./functions";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { isSummarizableMessage } from "./idleSummary";
import { addConversationToWorkItem } from "./conversationLinks";
import { performSetThreadState } from "./conversations";
import { composeHandoffPrompt, describeAgentRun, normalizeThreadState } from "@codecast/shared/contracts";

export const HANDOFF_MODEL = "claude-haiku-4-5-20251001";
// Transcript budget for the brief: the opening (goal) and the tail (latest
// work) of the SUMMARIZABLE turns, each capped, the final message kept longer
// because that is where the current ask usually sits.
export const HANDOFF_HEAD_MESSAGES = 8;
export const HANDOFF_TAIL_MESSAGES = 40;
export const HANDOFF_MESSAGE_CHARS = 1800;
export const HANDOFF_FINAL_CHARS = 6000;
export const HANDOFF_SCAN_LIMIT = 400;

export type HandoffTranscriptMessage = { role: "user" | "assistant"; content: string };

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}\n[… ${t.length - max} more chars]`;
}

/** Head + tail of the human-readable turns, oldest first. Pure. */
export function shapeHandoffTranscript(
  rowsNewestFirst: Array<{ role?: string; content?: string | null; tool_results?: unknown[] | null }>,
): HandoffTranscriptMessage[] {
  const readable = rowsNewestFirst.filter(isSummarizableMessage).reverse() as Array<{ role: "user" | "assistant"; content: string }>;
  const picked: typeof readable =
    readable.length <= HANDOFF_HEAD_MESSAGES + HANDOFF_TAIL_MESSAGES
      ? readable
      : [...readable.slice(0, HANDOFF_HEAD_MESSAGES), ...readable.slice(-HANDOFF_TAIL_MESSAGES)];
  return picked.map((m, i) => ({
    role: m.role,
    content: clip(m.content, i === picked.length - 1 && m.role === "assistant" ? HANDOFF_FINAL_CHARS : HANDOFF_MESSAGE_CHARS),
  }));
}

export interface HandoffBriefInput {
  title: string;
  agent: string;
  thread_state: string | null;
  task_short_id: string | null;
  plan_short_id: string | null;
  messages: HandoffTranscriptMessage[];
}

/** The Haiku prompt. Pure so a test and an eval read the exact prod text. */
export function buildHandoffBriefPrompt(input: HandoffBriefInput): string {
  const facts: string[] = [`Title: ${input.title}`, `Agent: ${input.agent}`];
  if (input.task_short_id) facts.push(`Bound task: ${input.task_short_id}`);
  if (input.plan_short_id) facts.push(`Bound plan: ${input.plan_short_id}`);
  if (input.thread_state) facts.push(`Pinned state (the agent's own last word on where things stand):\n${input.thread_state}`);
  const transcript = input.messages
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
  return `An agent session is being handed to a NEW session on another agent or model. The new session has none of this history. Write the brief it starts from.

Write markdown with exactly these sections, in this order, and leave a section out only when there is truly nothing for it:

## Goal
One or two sentences: what the work is for and what "done" looks like.

## Decisions
Each decision taken and WHY, one bullet each. Include alternatives that were rejected and the reason.

## Verified
What is proven to work and HOW (the exact command, test, screenshot or check), and what is explicitly NOT yet verified.

## Open questions
Unresolved questions and what would resolve each.

## Next steps
An ordered list. The FIRST step must be concrete enough to start cold: name the file, command or check.

Rules: state facts from the transcript, never invent. Prefer exact names (files, commands, ids, flags) over descriptions. Your reply is the brief itself: its first line is "## Goal" and its last line is the last next step. No preamble, no quoting of the transcript, no closing line, no mention of this instruction. Do not address the reader. Keep it under 500 words.

Session facts:
${facts.join("\n")}

Transcript (oldest first; the middle may be omitted):
${transcript}`;
}

/** The brief used when the model is unavailable: state plus the last word. */
export function fallbackHandoffBrief(input: HandoffBriefInput): string {
  const parts: string[] = ["_No model brief was available; this is assembled from the source's own records._", ""];
  if (input.thread_state) parts.push("## Pinned state", "", input.thread_state, "");
  const lastAssistant = [...input.messages].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) parts.push("## Last message from the source agent", "", lastAssistant.content, "");
  const firstUser = input.messages.find((m) => m.role === "user");
  if (firstUser) parts.push("## Opening request", "", firstUser.content, "");
  parts.push("## Next steps", "", "1. Read the tail of the source transcript with the commands below and continue from its last step.");
  return parts.join("\n");
}

// The one access rule for handing a session off: you run it or you own it —
// the same rule `cast state` uses, since the handoff pins the source's state.
async function callerId(ctx: any, apiToken?: string): Promise<Id<"users">> {
  const sessionUserId = ctx.auth ? await getAuthUserId(ctx) : null;
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId as Id<"users">;
  }
  throw new Error("Not authenticated");
}

export async function findHandoffSource(ctx: any, userId: Id<"users">, ref: string) {
  const conv = await findConversationByAnyRefWhere(ctx, ref, (c: any) =>
    c.user_id?.toString() === userId.toString() || c.owner_user_id?.toString() === userId.toString(),
  );
  if (!conv) throw new Error(`No session found for "${ref}" (you can only hand off sessions you run or own)`);
  return conv;
}

export interface HandoffSourceFacts {
  conversation_id: Id<"conversations">;
  short_id: string;
  title: string | null;
  agent_type: string | null;
  model: string | null;
  message_count: number;
  project_path: string | null;
  git_root: string | null;
  task_short_id: string | null;
  plan_short_id: string | null;
  thread_state: string | null;
  handed_off_to_conversation_id: string | null;
}

export interface HandoffBriefPayload {
  source: HandoffSourceFacts;
  messages: HandoffTranscriptMessage[];
}

export interface HandoffStartResult {
  source: Omit<HandoffSourceFacts, "git_root" | "thread_state" | "handed_off_to_conversation_id">;
  prompt: string;
  brief: string;
  brief_source: "model" | "fallback";
  session: {
    conversation_id: Id<"conversations">;
    short_id: string;
    agent_type: string;
    model: string | null;
    effort: string | null;
    project_path: string | null;
  } | null;
}

// Explicit return types on both functions: the action reads the query through
// the generated api types and the query's module also holds the action, so
// without them tsc sees each initializer inside the other (TS7022).
export const briefInput = internalQuery({
  args: { api_token: v.optional(v.string()), conversation_id: v.string() },
  handler: async (ctx, args): Promise<HandoffBriefPayload> => {
    const userId = await callerId(ctx, args.api_token);
    const conv: any = await findHandoffSource(ctx, userId, args.conversation_id);
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
      .order("desc")
      .take(HANDOFF_SCAN_LIMIT);
    const task: any = conv.active_task_id ? await ctx.db.get(conv.active_task_id) : null;
    const plan: any = conv.active_plan_id ? await ctx.db.get(conv.active_plan_id) : null;
    const short_id = conv.short_id ?? conv._id.toString().slice(0, 7);
    return {
      source: {
        conversation_id: conv._id as Id<"conversations">,
        short_id,
        title: (conv.title as string | undefined) ?? null,
        agent_type: (conv.agent_type as string | undefined) ?? null,
        model: (conv.model as string | undefined) ?? null,
        message_count: (conv.message_count as number | undefined) ?? 0,
        project_path: (conv.project_path as string | undefined) ?? null,
        git_root: (conv.git_root as string | undefined) ?? null,
        task_short_id: (task?.short_id as string | undefined) ?? null,
        plan_short_id: (plan?.short_id as string | undefined) ?? null,
        thread_state: (conv.thread_state as string | undefined) ?? null,
        handed_off_to_conversation_id: (conv.handed_off_to_conversation_id as string | undefined) ?? null,
      },
      messages: shapeHandoffTranscript(rows as any[]),
    };
  },
});

async function askForBrief(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: HANDOFF_MODEL,
        max_tokens: 1200,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) {
      console.error("Handoff brief API error:", response.status);
      return null;
    }
    const data = await response.json();
    const text = (data.content?.[0]?.text ?? "").trim();
    return text || null;
  } catch (error) {
    console.error("Handoff brief failed:", error);
    return null;
  }
}

const AGENT_TYPES = ["claude_code", "codex", "cursor", "gemini", "opencode", "pi", "grok", "muse"] as const;

// handoff.start — the whole handoff. Callable from the web as a signed-in
// action (conversation_id + agent_type/model/effort/direction) and from the
// CLI over /cli/handoff with api_token. Absent agent_type = the source's own
// agent. dry_run composes and returns the prompt without starting anything.
export const start = action({
  args: {
    api_token: v.optional(v.string()),
    /** Any ref to one of the caller's sessions: convex id, short id, or session uuid. */
    conversation_id: v.string(),
    agent_type: v.optional(v.union(...AGENT_TYPES.map((t) => v.literal(t)))),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    cc_account: v.optional(v.string()),
    device: v.optional(v.string()),
    direction: v.optional(v.string()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<HandoffStartResult> => {
    const { source, messages }: HandoffBriefPayload = await ctx.runQuery(internal.handoff.briefInput, {
      api_token: args.api_token,
      conversation_id: args.conversation_id,
    });
    const agentType = args.agent_type ?? (source.agent_type as (typeof AGENT_TYPES)[number] | null) ?? "claude_code";
    const briefInputs: HandoffBriefInput = {
      title: source.title ?? "Untitled session",
      agent: describeAgentRun(source.agent_type, source.model),
      thread_state: source.thread_state,
      task_short_id: source.task_short_id,
      plan_short_id: source.plan_short_id,
      messages,
    };
    const modelBrief = messages.length ? await askForBrief(buildHandoffBriefPrompt(briefInputs)) : null;
    const brief = modelBrief ?? fallbackHandoffBrief(briefInputs);
    const prompt = composeHandoffPrompt({ source, brief, direction: args.direction });

    const sourceOut: HandoffStartResult["source"] = {
      conversation_id: source.conversation_id,
      short_id: source.short_id,
      title: source.title,
      agent_type: source.agent_type,
      model: source.model,
      message_count: source.message_count,
      task_short_id: source.task_short_id,
      plan_short_id: source.plan_short_id,
      project_path: source.project_path,
    };
    if (args.dry_run) {
      return { source: sourceOut, prompt, brief, brief_source: modelBrief ? ("model" as const) : ("fallback" as const), session: null };
    }

    const created: { conversation_id: Id<"conversations">; short_id: string } = await ctx.runMutation(
      (api as any).spawn.createSessionFromCli,
      {
        api_token: args.api_token,
        prompt,
        project_path: source.project_path ?? undefined,
        git_root: source.git_root ?? undefined,
        agent_type: agentType,
        model: args.model,
        effort: args.effort,
        cc_account: args.cc_account,
        device: args.device,
        spawner_session: String(source.conversation_id),
        handoff_from_session: String(source.conversation_id),
      },
    );
    return {
      source: sourceOut,
      prompt,
      brief,
      brief_source: modelBrief ? ("model" as const) : ("fallback" as const),
      session: {
        conversation_id: created.conversation_id,
        short_id: created.short_id,
        agent_type: agentType,
        model: args.model ?? null,
        effort: args.effort ?? null,
        project_path: source.project_path,
      },
    };
  },
});

// ── The link, applied inside createSessionFromCli ───────────────────────────
//
// Runs in the SAME mutation that inserted the child, so the pair of pointers,
// the task/plan binding and the source's pinned state land or fail together.
// The child row was born with handed_off_from_conversation_id (see
// spawnSessionCore's handoffFrom); this writes everything that hangs off it.

/** The fields the child inherits at insert: the pointer and the work binding. */
export function handoffChildFields(source: any): Record<string, unknown> {
  return {
    handed_off_from_conversation_id: source._id,
    ...(source.active_task_id ? { active_task_id: source.active_task_id } : {}),
    ...(source.active_plan_id ? { active_plan_id: source.active_plan_id } : {}),
    ...(source.plan_ids?.length ? { plan_ids: source.plan_ids } : {}),
  };
}

export function handoffStateLine(childShortId: string, agentType: string | null | undefined, model?: string | null): string {
  return normalizeThreadState(`Handed off to ${childShortId} on ${describeAgentRun(agentType, model)}`);
}

export async function applyHandoffLink(
  ctx: any,
  userId: Id<"users">,
  source: any,
  child: { _id: Id<"conversations">; short_id: string; agent_type?: string | null; model?: string | null },
): Promise<void> {
  await ctx.db.patch(source._id, { handed_off_to_conversation_id: child._id });

  // The board follows the work: the child joins the task's and the plan's
  // session lists the way `cast task start` / `cast plan bind` add a session.
  if (source.active_task_id) {
    const task = await ctx.db.get(source.active_task_id);
    if (task) await addConversationToWorkItem(ctx, userId, "task", task, child._id);
  }
  if (source.active_plan_id) {
    const plan = await ctx.db.get(source.active_plan_id);
    if (plan) {
      await addConversationToWorkItem(ctx, userId, "plan", plan, child._id, { current_session_id: child._id, updated_at: Date.now() });
    }
  }

  // The source is finished: its pinned state names the successor, filed as
  // done so it leaves Needs Input. The source agent ends its turn after this.
  await performSetThreadState(ctx, source, handoffStateLine(child.short_id, child.agent_type, child.model), "done");
}
