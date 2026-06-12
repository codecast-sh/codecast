import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

export const setTitleAndSubtitle = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    subtitle: v.string(),
  },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return;
    const patch: { title?: string; subtitle?: string } = { subtitle: args.subtitle };
    if (!conv.title_is_custom) patch.title = args.title;
    await ctx.db.patch(args.conversation_id, patch);
  },
});

export const generateTitle = internalAction({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY not configured");
      return;
    }

    const conversation = await ctx.runQuery(internal.titleGeneration.getConversationForTitle, {
      conversation_id: args.conversation_id,
    });

    if (!conversation || (conversation.spine.length === 0 && conversation.recent.length === 0)) {
      return;
    }

    const messageText = buildTitleMessageContext(conversation.spine, conversation.recent);

    const prompt = buildTitlePrompt({
      messageText,
      currentTitle: conversation.currentTitle,
      messageCount: conversation.messageCount,
    });

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 400,
          // Deterministic: the same conversation state must yield the same
          // title, otherwise every regeneration re-rolls borderline keeps.
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        console.error("Haiku API error:", response.status, await response.text());
        return;
      }

      const data = await response.json();
      const text = data.content?.[0]?.text?.trim();

      if (!text) return;

      const parsed = extractTitleJson(text);
      const title = parsed?.title?.trim();

      if (title && title.length < 200) {
        await ctx.runMutation(internal.titleGeneration.setTitleAndSubtitle, {
          conversation_id: args.conversation_id,
          title,
          subtitle: parsed?.subtitle?.trim() || "",
        });
      } else {
        console.error("Title generation returned no usable JSON:", text.slice(0, 120));
      }
    } catch (error) {
      console.error("Failed to generate title:", error);
    }
  },
});

// Spine sampling: the session's timespan is split into equal time buckets and
// each contributes up to a few human prompts. Most user-role rows in agentic
// sessions are tool-result carriers, so an end-anchored fetch would miss the
// middle of long sessions entirely; time buckets keep coverage uniform over
// the session's whole life while the per-bucket take() bounds result size.
const SPINE_BUCKETS = 12;
const SPINE_PER_BUCKET = 4;
const SPINE_END_FETCH = 10;

// User rows that are real prompts but carry no topic signal — interruption
// markers, bare image sends, background-task callbacks, import notices, fork
// scaffolding. They'd waste spine slots and anchor the model on noise.
export function isLowSignalPrompt(content: string): boolean {
  const t = content.trimStart();
  return (
    t.startsWith("[Request interrupted") ||
    t.startsWith("<task-notification>") ||
    t.startsWith("<fork-boilerplate>") ||
    t.startsWith("[Codecast import]") ||
    /^\[image\]$/i.test(t.trim())
  );
}

export const getConversationForTitle = internalQuery({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    const isHumanText = (m: { content?: string | null; tool_results?: unknown[] | null }) =>
      !!m.content && !m.tool_results?.length;

    const userPrompts = (dir: "asc" | "desc") =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id).eq("role", "user")
        )
        .order(dir)
        .filter((q) =>
          q.and(
            q.eq(q.field("tool_results"), undefined),
            q.neq(q.field("content"), undefined)
          )
        );

    // Prompts cluster in time, so buckets alone under-sample dense stretches.
    // Union three views: the opening prompts (where the user states the goal),
    // time buckets across the span (the arc), and the trailing prompts (where
    // the work is now). Dedupe and re-sort chronologically.
    const firstPrompts = await userPrompts("asc").take(SPINE_END_FETCH);
    const lastPrompts = await userPrompts("desc").take(SPINE_END_FETCH);

    const spineRows: Doc<"messages">[] = [...firstPrompts, ...lastPrompts];
    const lo = firstPrompts[0]?.timestamp;
    const hi = lastPrompts[0]?.timestamp;
    if (lo !== undefined && hi !== undefined && hi > lo) {
      const promptsInRange = (t0: number, t1: number) =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) =>
            q
              .eq("conversation_id", args.conversation_id)
              .eq("role", "user")
              .gte("timestamp", t0)
              .lt("timestamp", t1)
          )
          .filter((q) =>
            q.and(
              q.eq(q.field("tool_results"), undefined),
              q.neq(q.field("content"), undefined)
            )
          )
          .take(SPINE_PER_BUCKET);

      const span = hi + 1 - lo;
      const bucketRows = await Promise.all(
        Array.from({ length: SPINE_BUCKETS }, (_, k) =>
          promptsInRange(lo + (span * k) / SPINE_BUCKETS, lo + (span * (k + 1)) / SPINE_BUCKETS)
        )
      );
      spineRows.push(...bucketRows.flat());
    }

    const seenSpine = new Set<string>();
    const orderedSpine = spineRows
      .filter((m) => {
        if (seenSpine.has(m._id)) return false;
        seenSpine.add(m._id);
        return true;
      })
      .sort((a, b) => a.timestamp - b.timestamp);

    // Recent window: the last few exchanges (any role) so the subtitle can
    // describe what is happening right now.
    const latest = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .take(20);

    const recent = latest
      .reverse()
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          isHumanText(m) &&
          !isLowSignalPrompt(m.content!)
      );

    const recentIds = new Set(recent.map((m) => m._id));
    const spine = orderedSpine.filter(
      (m) => isHumanText(m) && !isLowSignalPrompt(m.content!) && !recentIds.has(m._id)
    );

    // Anchor on the existing title only when it came from a previous LLM pass
    // (which always writes a subtitle). Daemon-created placeholder titles have
    // no subtitle and must not be kept verbatim; custom titles are never
    // overwritten, so anchoring on them is pointless.
    const llmTitled = !conversation.title_is_custom && !!conversation.subtitle;

    return {
      spine: spine.map((m) => ({ role: m.role, content: m.content })),
      recent: recent.map((m) => ({ role: m.role, content: m.content })),
      currentTitle: llmTitled ? conversation.title : undefined,
      messageCount: conversation.message_count ?? 0,
    };
  },
});

// How many spine prompts / recent messages reach the model, and how hard each
// is truncated. Sized so the full context stays within the budget of the
// previous two-window design (~7KB of message text) — this runs on a cadence,
// so the spend per call must not grow with session length.
const SPINE_MAX = 20;
const SPINE_CHARS = 250;
const RECENT_MAX = 4;
const RECENT_CHARS = 350;

export function buildTitlePrompt(input: {
  messageText: string;
  currentTitle?: string;
  messageCount: number;
}): string {
  const anchor = input.currentTitle
    ? `\nThe current title is ${JSON.stringify(input.currentTitle)}. Judge it against the user requests below: if it names the goal most of the requests serve, keep it VERBATIM — do not reword a correct title. If it names only a recent step or a minority topic while most requests serve a different goal, replace it with a title for that dominant goal. Requests that refine, polish, or extend the thing built earlier in the session serve that same goal — they are NOT a reason to retitle.`
    : "";

  return `Generate a title and subtitle for this coding session.

Title: 2-5 words max. Short noun phrase or verb phrase naming what the session AS A WHOLE is about — the goal most of the user's requests serve, not whatever step is in progress right now. Think git branch names but readable.${anchor}
Examples: "Auth redirect fix", "Dark mode settings", "Replace chokidar", "Inbox card redesign", "FD leak debug"
Anti-examples (too verbose): "Investigate Non-Resumable Session Root Cause", "Implement agent-triggered community chat with leave option", "Add Sessions tab to mobile with chronological summaries"

Subtitle: Bullet points (2-4 lines) describing what was done. Each bullet starts with "- ". Cover: what was built/fixed/changed, key files or components, current state. The subtitle tracks the latest work — recency belongs here, not in the title.
Examples:
"- Switched from chokidar to native fs.watch, cut FD usage 3x\n- Updated daemon.ts and fileWatcher.ts\n- Working, deployed"
"- Fixed OAuth refresh token race condition in auth middleware\n- Added retry logic in sessionValidator.ts\n- In progress, needs testing"

Session with ${input.messageCount} messages:
${input.messageText}

Do not respond to the conversation. Output ONLY the JSON object, no markdown, no preamble:
{"title": "...", "subtitle": "..."}`;
}

// Build the conversation excerpt fed to the title model. Two sections: the
// user's prompts sampled evenly across the WHOLE session (the topic signal the
// title must name) and the last few exchanges (the status the subtitle must
// describe). The labels let each prompt instruction bind to the right block.
export function buildTitleMessageContext(
  spine: Array<{ role: string; content?: string }>,
  recent: Array<{ role: string; content?: string }>,
): string {
  const truncate = (content: string | undefined, maxLen: number) => {
    if (!content) return "[no text]";
    return content.length <= maxLen ? content : content.slice(0, maxLen) + "...";
  };
  const fmt = (m: { role: string; content?: string }, maxLen: number) =>
    `${m.role === "assistant" ? "Assistant" : "User"}: ${truncate(m.content, maxLen)}`;

  const sampledSpine = sampleEvenly(spine, SPINE_MAX);
  const recentWindow = recent.slice(-RECENT_MAX);

  const sections: string[] = [];
  if (sampledSpine.length) {
    sections.push(
      `=== User requests across the session (oldest to newest) ===\n${sampledSpine
        .map((m) => fmt(m, SPINE_CHARS))
        .join("\n\n")}`
    );
  }
  if (recentWindow.length) {
    sections.push(
      `=== Most recent activity ===\n${recentWindow.map((m) => fmt(m, RECENT_CHARS)).join("\n\n")}`
    );
  }
  return sections.join("\n\n");
}

// Pull the {"title", "subtitle"} object out of a model response. The model
// occasionally wraps the JSON in a fence or a preamble (or answers the
// conversation instead) — take the outermost brace span and parse that. A null
// here means skip the update; raw text must never become a title.
export function extractTitleJson(
  text: string,
): { title?: string; subtitle?: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle : undefined,
    };
  } catch {
    return null;
  }
}

// Evenly sample `max` items, always keeping the first and last.
export function sampleEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return [items[0]];
  const picked: T[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(items[Math.round((i * (items.length - 1)) / (max - 1))]);
  }
  return picked;
}

export function shouldGenerateTitle(messageCount: number): boolean {
  if (messageCount === 2) return true;
  if (messageCount <= 20) return messageCount % 5 === 0;
  if (messageCount <= 60) return messageCount % 10 === 0;
  return messageCount % 20 === 0;
}
