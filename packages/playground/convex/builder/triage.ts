// Triage: an Auto message is stored as chat marked pending, and a fast model
// decides whether it asks for a change. A change becomes a request with a
// queued build, in place; anything else (including a triage that fails)
// stays chat. The composer's "Change it" and "Just chat" skip this.
import { runAssistant } from "@platform/agent";
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { BUILD_ROOM_CONTEXT } from "../lib/limits";
import { TRIAGE_MODEL, TRIAGE_SYSTEM, parseTriage, triagePrompt } from "../prompts";
import { enqueueBuild, roomBefore } from "./queue";

const TRIAGE_CEILING_USD = 0.02;
const TRIAGE_DEADLINE_MS = 15_000;
/** The smallest cap the harness makes a call with; the answer is one word. */
const TRIAGE_MAX_TOKENS = 1_024;

export const input = internalQuery({
  args: { message_id: v.id("messages") },
  handler: async (ctx, { message_id }) => {
    const message = await ctx.db.get(message_id);
    if (message?.triage !== "pending") return null;
    return {
      body: message.body,
      element: message.element ?? null,
      room: await roomBefore(ctx, message, Math.ceil(BUILD_ROOM_CONTEXT / 2)),
    };
  },
});

export const classify = internalAction({
  args: { message_id: v.id("messages") },
  handler: async (ctx, { message_id }): Promise<null> => {
    const found = await ctx.runQuery(internal.builder.triage.input, { message_id });
    if (!found) return null;
    const result = await runAssistant({
      model: TRIAGE_MODEL,
      system: TRIAGE_SYSTEM,
      history: [{ role: "user", content: triagePrompt(found) }],
      ceilingUsd: TRIAGE_CEILING_USD,
      deadlineMs: TRIAGE_DEADLINE_MS,
      maxTokens: TRIAGE_MAX_TOKENS,
      apiKeys: { anthropic: process.env.ANTHROPIC_API_KEY },
    });
    const answer = result.messages.findLast((m) => m.role === "assistant" && m.content)?.content ?? "";
    if (result.reason !== "done") console.warn(`[triage] ${message_id} stopped: ${result.reason} ${result.error ?? ""}`);
    await ctx.runMutation(internal.builder.triage.settle, { message_id, kind: parseTriage(answer) ?? "chat" });
    return null;
  },
});

/** Settle a pending message: a change queues its build (unless the asker is
 *  over the build rate, when it stays chat); chat just clears the mark. */
export const settle = internalMutation({
  args: { message_id: v.id("messages"), kind: v.union(v.literal("change"), v.literal("chat")) },
  handler: async (ctx, { message_id, kind }) => {
    const message = await ctx.db.get(message_id);
    if (message?.triage !== "pending") return;
    const app = kind === "change" && message.visitor_id ? await ctx.db.get(message.app_id) : null;
    if (app && message.visitor_id) {
      try {
        await enqueueBuild(ctx, app, message, message.visitor_id);
        return;
      } catch (e) {
        if (!(e instanceof ConvexError)) throw e;
      }
    }
    await ctx.db.patch(message_id, { triage: undefined });
  },
});
