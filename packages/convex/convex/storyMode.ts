import { v } from "convex/values";
import { query, action, internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessConversation } from "./lib/access";
import { isLowSignalPrompt, sampleEvenly } from "./titleGeneration";

// Story mode condenses a conversation into a first-person timeline: user
// prompts verbatim, long assistant messages rewritten (shorter, same voice) by
// Haiku and cached in message_summaries. Summary mode goes one level higher:
// a single whole-thread narrative cached in conversation_summaries.

// Assistant messages at or under this length read fine as-is — no LLM pass.
const VERBATIM_MAX = 360;
// Per-action cap on Haiku calls; the client re-fires while pending remain.
const MAX_SUMMARIES_PER_RUN = 120;
const HAIKU_BATCH = 8;
const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
// Fetch caps — generous enough for very long threads while bounding the query.
const MAX_USER_ROWS = 500;
const MAX_ASSISTANT_ROWS = 1000;
// Regenerate the thread summary once this many messages arrived since the
// cached one was written.
export const THREAD_SUMMARY_STALE_AFTER = 12;

type StoryEntry = {
  message_id: string;
  role: "user" | "assistant";
  timestamp: number;
  // "verbatim" renders text as the original message, "summary" as a condensed
  // rewrite, "pending" as a placeholder while generation runs.
  kind: "verbatim" | "summary" | "pending";
  text: string;
};

function hasStoryText(m: { content?: string; tool_results?: unknown[] }): boolean {
  return !!m.content && m.content.trim().length > 0 && !m.tool_results?.length;
}

async function fetchStoryMessages(
  ctx: { db: any },
  conversationId: string,
) {
  const byRole = (role: "user" | "assistant", cap: number) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation_role_timestamp", (q: any) =>
        q.eq("conversation_id", conversationId).eq("role", role)
      )
      .filter((q: any) => q.neq(q.field("content"), undefined))
      .take(cap);
  const [userRows, assistantRows] = await Promise.all([
    byRole("user", MAX_USER_ROWS),
    byRole("assistant", MAX_ASSISTANT_ROWS),
  ]);
  return {
    userRows: userRows.filter((m: any) => hasStoryText(m) && !isLowSignalPrompt(m.content)),
    assistantRows: assistantRows.filter((m: any) => hasStoryText(m)),
  };
}

async function requireConversationAccess(ctx: any, conversationId: string) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return null;
  if (!(await canAccessConversation(ctx, userId, conversation))) return null;
  return conversation;
}

export const getStory = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(ctx, args.conversation_id);
    if (!conversation) return null;

    const { userRows, assistantRows } = await fetchStoryMessages(ctx, args.conversation_id);
    const summaries = await ctx.db
      .query("message_summaries")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    const summaryByMessage = new Map(summaries.map((s) => [s.message_id as string, s.summary]));

    const entries: StoryEntry[] = [];
    for (const m of userRows) {
      entries.push({
        message_id: m._id,
        role: "user",
        timestamp: m.timestamp,
        kind: "verbatim",
        text: m.content!.length > 2000 ? m.content!.slice(0, 2000) + "…" : m.content!,
      });
    }
    let pendingCount = 0;
    for (const m of assistantRows) {
      const content = m.content!;
      const cached = summaryByMessage.get(m._id as string);
      let kind: StoryEntry["kind"];
      let text: string;
      if (content.length <= VERBATIM_MAX) {
        kind = "verbatim";
        text = content;
      } else if (cached) {
        kind = "summary";
        text = cached;
      } else {
        kind = "pending";
        text = "";
        pendingCount++;
      }
      entries.push({ message_id: m._id, role: "assistant", timestamp: m.timestamp, kind, text });
    }
    entries.sort((a, b) => a.timestamp - b.timestamp);
    return { entries, pendingCount };
  },
});

export const getThreadSummary = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(ctx, args.conversation_id);
    if (!conversation) return null;
    const row = await ctx.db
      .query("conversation_summaries")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .unique();
    const currentCount = conversation.message_count ?? 0;
    return {
      summary: row?.summary ?? null,
      generated_at: row?.generated_at ?? null,
      message_count: row?.message_count ?? 0,
      stale: !row || currentCount - row.message_count >= THREAD_SUMMARY_STALE_AFTER,
    };
  },
});

// ── Generation ──────────────────────────────────────────────────────────────

export const getSummaryWork = internalQuery({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    if (!(await canAccessConversation(ctx, args.user_id, conversation))) return null;

    const { assistantRows } = await fetchStoryMessages(ctx, args.conversation_id);
    const summaries = await ctx.db
      .query("message_summaries")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    const done = new Set(summaries.map((s) => s.message_id as string));
    return assistantRows
      .filter((m: any) => m.content.length > VERBATIM_MAX && !done.has(m._id as string))
      .slice(0, MAX_SUMMARIES_PER_RUN)
      .map((m: any) => ({ message_id: m._id, timestamp: m.timestamp, content: m.content as string }));
  },
});

export const insertMessageSummary = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    timestamp: v.number(),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    // Idempotent: concurrent clients may race the same pending message.
    const existing = await ctx.db
      .query("message_summaries")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .unique();
    if (existing) return;
    await ctx.db.insert("message_summaries", { ...args, model: SUMMARY_MODEL });
  },
});

async function callHaiku(apiKey: string, prompt: string, maxTokens: number): Promise<string | null> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    console.error("storyMode Haiku error:", response.status, await response.text());
    return null;
  }
  const data = await response.json();
  const text = data.content?.[0]?.text?.trim();
  return text ? stripModelPreamble(text) : null;
}

// Haiku sometimes prefixes the answer with a reasoning block (<analysis>…</analysis>
// or <thinking>…</thinking>) despite being told to output only the result. Drop a
// leading such block; leave the genuine answer untouched.
export function stripModelPreamble(text: string): string {
  const stripped = text.replace(/^\s*<(analysis|thinking)>[\s\S]*?<\/\1>\s*/i, "");
  return stripped.trim() || text.trim();
}

// Long messages are condensed from their head and tail — the middle of a very
// long assistant message is usually detail the rewrite drops anyway.
function clipForPrompt(content: string): string {
  if (content.length <= 9000) return content;
  return content.slice(0, 6500) + "\n…\n" + content.slice(-2000);
}

function buildMessageSummaryPrompt(content: string): string {
  return `Below is one message written by an AI coding assistant during a working session. Rewrite it as a much shorter version of itself.

Rules:
- First person, exactly the same voice and tone as the original author — it must read like the author's own tighter draft, never like a third-party summary ("I fixed X", never "The assistant fixed X").
- 1-3 sentences for most messages; up to 5 short lines for very long ones.
- Keep the concrete specifics that matter: file names, decisions, findings, numbers, outcomes.
- Keep light markdown (inline \`code\`, **bold**) where it helps. No headers. Only use a list if the original is essentially a list.
- Output ONLY the rewritten message — no preamble, no quotes, no commentary.

<message>
${clipForPrompt(content)}
</message>`;
}

export const generateStorySummaries = action({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<{ generated: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { generated: 0 };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not configured");
      return { generated: 0 };
    }
    const work = await ctx.runQuery(internal.storyMode.getSummaryWork, {
      conversation_id: args.conversation_id,
      user_id: userId,
    });
    if (!work || work.length === 0) return { generated: 0 };

    let generated = 0;
    for (let i = 0; i < work.length; i += HAIKU_BATCH) {
      const batch = work.slice(i, i + HAIKU_BATCH);
      await Promise.all(
        batch.map(async (item: { message_id: string; timestamp: number; content: string }) => {
          try {
            const text = await callHaiku(apiKey, buildMessageSummaryPrompt(item.content), 600);
            if (!text) return;
            await ctx.runMutation(internal.storyMode.insertMessageSummary, {
              conversation_id: args.conversation_id,
              message_id: item.message_id as any,
              timestamp: item.timestamp,
              summary: text,
            });
            generated++;
          } catch (err) {
            console.error("storyMode summary failed:", err);
          }
        })
      );
    }
    return { generated };
  },
});

export const getThreadSummaryInput = internalQuery({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    if (!(await canAccessConversation(ctx, args.user_id, conversation))) return null;

    const { userRows, assistantRows } = await fetchStoryMessages(ctx, args.conversation_id);
    const summaries = await ctx.db
      .query("message_summaries")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    const summaryByMessage = new Map(summaries.map((s) => [s.message_id as string, s.summary]));

    const rows = [...userRows, ...assistantRows].sort((a: any, b: any) => a.timestamp - b.timestamp);
    const lines = rows.map((m: any) => {
      const text =
        m.role === "assistant"
          ? summaryByMessage.get(m._id as string) ?? m.content
          : m.content;
      const clipped = text.length > 700 ? text.slice(0, 700) + "…" : text;
      return `${m.role === "user" ? "User" : "Me"}: ${clipped}`;
    });
    return {
      lines: sampleEvenly(lines, 120),
      message_count: conversation.message_count ?? rows.length,
    };
  },
});

export const upsertThreadSummary = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    summary: v.string(),
    message_count: v.number(),
    generated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversation_summaries")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        summary: args.summary,
        message_count: args.message_count,
        generated_at: args.generated_at,
        model: SUMMARY_MODEL,
      });
    } else {
      await ctx.db.insert("conversation_summaries", { ...args, model: SUMMARY_MODEL });
    }
  },
});

function buildThreadSummaryPrompt(lines: string[]): string {
  return `Below is a working session between a user and an AI coding assistant ("Me" lines are the assistant), in order. Long assistant messages have already been condensed.

Write the story of this session as a short narrative in markdown, in first person from the assistant's perspective, keeping the assistant's voice and tone.

Shape:
- Open with one or two sentences on what the session set out to do.
- Then the journey: short paragraphs (or tight bullets where natural) covering the key turns — discoveries, decisions, dead ends, fixes — with concrete file, feature, and system names.
- Close with where things stand now: what's done, what's open.

Length: scale to how much actually happened — roughly 120 words for a small session, up to 400 for a long winding one. Markdown is fine (a few bold leads or bullets); no top-level title.

Do not think out loud or include any analysis, preamble, or tags. Output ONLY the final narrative markdown, starting with the first sentence of the story.

<session>
${lines.join("\n\n")}
</session>`;
}

export const generateThreadSummary = action({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not configured");
      return { ok: false };
    }
    const input = await ctx.runQuery(internal.storyMode.getThreadSummaryInput, {
      conversation_id: args.conversation_id,
      user_id: userId,
    });
    if (!input || input.lines.length === 0) return { ok: false };
    const text = await callHaiku(apiKey, buildThreadSummaryPrompt(input.lines), 1500);
    if (!text) return { ok: false };
    await ctx.runMutation(internal.storyMode.upsertThreadSummary, {
      conversation_id: args.conversation_id,
      summary: text,
      message_count: input.message_count,
      generated_at: Date.now(),
    });
    return { ok: true };
  },
});
