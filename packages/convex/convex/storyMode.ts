import { v } from "convex/values";
import { query, action, internalQuery, internalMutation, internalAction } from "./functions";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessConversation } from "./lib/access";
import { isLowSignalPrompt, sampleEvenly } from "./titleGeneration";

// Story and Summary are chunked first-person retellings of a session. Rather
// than summarize every message (which just reproduces the conversation at 1:1),
// the conversation is cut into a handful of BEATS — each beat spans several
// turns and gets one short narrative in the author's own voice, anchored to the
// user prompt that opens it. Summary is the same idea one level up: the beats
// are grouped into a few PHASES. Both are cached as JSON and regenerate when the
// conversation has grown enough.

const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const MAX_USER_ROWS = 600;
const MAX_ASSISTANT_ROWS = 1500;
// Regenerate once this many messages arrived since the cached level was built.
export const STALE_AFTER = 15;
// Concurrency for the per-beat Haiku calls.
const HAIKU_BATCH = 6;

export type Beat = {
  heading: string;
  body: string;
  anchor_prompt: string;
  anchor_message_id: string;
  anchor_timestamp: number;
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function hasStoryText(m: { content?: string; tool_results?: unknown[] }): boolean {
  return !!m.content && m.content.trim().length > 0 && !m.tool_results?.length;
}

async function fetchRows(ctx: { db: any }, conversationId: string) {
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
  const rows = [
    ...userRows.filter((m: any) => hasStoryText(m) && !isLowSignalPrompt(m.content)),
    ...assistantRows.filter((m: any) => hasStoryText(m)),
  ].sort((a: any, b: any) => a.timestamp - b.timestamp);
  return rows.map((m: any) => ({ id: m._id as string, role: m.role as string, content: m.content as string, ts: m.timestamp as number }));
}

type Row = { id: string; role: string; content: string; ts: number };
type Turn = { promptId: string; promptTs: number; prompt: string; assistant: string[] };

// A turn = one user prompt plus all the assistant text up to the next prompt.
function buildTurns(rows: Row[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const r of rows) {
    if (r.role === "user") {
      cur = { promptId: r.id, promptTs: r.ts, prompt: r.content, assistant: [] };
      turns.push(cur);
    } else if (r.role === "assistant") {
      if (!cur) {
        cur = { promptId: r.id, promptTs: r.ts, prompt: "", assistant: [] };
        turns.push(cur);
      }
      cur.assistant.push(r.content);
    }
  }
  return turns;
}

// Split a list into `count` contiguous, near-even groups.
function chunkInto<T>(items: T[], count: number): T[][] {
  if (items.length === 0) return [];
  const n = Math.max(1, Math.min(count, items.length));
  const per = Math.ceil(items.length / n);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += per) out.push(items.slice(i, i + per));
  return out;
}

// How many beats / phases to target for a session of this size. Sub-linear so a
// long session reads as a tight story, not a transcript.
function beatCount(turnCount: number): number {
  if (turnCount <= 6) return turnCount;
  return Math.min(16, Math.max(6, Math.round(turnCount / 2.5)));
}
function phaseCount(beatCount: number): number {
  if (beatCount <= 4) return Math.max(1, beatCount);
  return Math.min(6, Math.max(3, Math.round(beatCount / 3)));
}

async function requireAccess(ctx: any, conversationId: string) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  const conv = await ctx.db.get(conversationId);
  if (!conv) return null;
  if (!(await canAccessConversation(ctx, userId, conv))) return null;
  return conv;
}

// ── Read queries ─────────────────────────────────────────────────────────────

function readLevel(row: any, level: "story" | "summary", currentCount: number) {
  const raw = row?.[level] as string | undefined;
  const builtAt = (row?.[`${level}_message_count`] as number | undefined) ?? 0;
  let items: Beat[] = [];
  if (raw) {
    try { items = JSON.parse(raw); } catch { items = []; }
  }
  return {
    items,
    generated_at: row?.generated_at ?? null,
    message_count: builtAt,
    stale: !raw || currentCount - builtAt >= STALE_AFTER,
  };
}

export const getStory = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conv = await requireAccess(ctx, args.conversation_id);
    if (!conv) return null;
    const row = await ctx.db
      .query("conversation_summaries")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .unique();
    return readLevel(row, "story", conv.message_count ?? 0);
  },
});

export const getSummary = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conv = await requireAccess(ctx, args.conversation_id);
    if (!conv) return null;
    const row = await ctx.db
      .query("conversation_summaries")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .unique();
    return readLevel(row, "summary", conv.message_count ?? 0);
  },
});

// ── Generation inputs ────────────────────────────────────────────────────────

export const getStoryInput = internalQuery({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    if (!(await canAccessConversation(ctx, args.user_id, conv))) return null;
    const rows = await fetchRows(ctx, args.conversation_id);
    const turns = buildTurns(rows);
    return { turns, message_count: conv.message_count ?? rows.length };
  },
});

export const getCachedStory = internalQuery({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    if (!(await canAccessConversation(ctx, args.user_id, conv))) return null;
    const row = await ctx.db
      .query("conversation_summaries")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .unique();
    let beats: Beat[] = [];
    if (row?.story) { try { beats = JSON.parse(row.story); } catch { beats = []; } }
    return { beats, message_count: conv.message_count ?? 0 };
  },
});

export const writeLevel = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    level: v.union(v.literal("story"), v.literal("summary")),
    json: v.string(),
    message_count: v.number(),
    generated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conversation_summaries")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .unique();
    const patch: Record<string, unknown> = {
      [args.level]: args.json,
      [`${args.level}_message_count`]: args.message_count,
      generated_at: args.generated_at,
      model: SUMMARY_MODEL,
    };
    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("conversation_summaries", { conversation_id: args.conversation_id, ...patch } as any);
  },
});

// ── Haiku ────────────────────────────────────────────────────────────────────

async function callHaiku(apiKey: string, prompt: string, maxTokens: number): Promise<string | null> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: SUMMARY_MODEL, max_tokens: maxTokens, temperature: 0, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) {
    console.error("storyMode Haiku error:", response.status, await response.text());
    return null;
  }
  const data = await response.json();
  const text = data.content?.[0]?.text?.trim();
  return text ? stripModelPreamble(text) : null;
}

// Haiku sometimes prefixes a reasoning block despite instructions. Drop a
// leading <analysis>/<thinking> block; leave a genuine answer untouched.
export function stripModelPreamble(text: string): string {
  const stripped = text.replace(/^\s*<(analysis|thinking)>[\s\S]*?<\/\1>\s*/i, "");
  return stripped.trim() || text.trim();
}

// Pull {heading, body} out of a model response (may be fenced or prefixed).
export function extractBeatJson(text: string): { heading?: string; body?: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      heading: typeof parsed.heading === "string" ? parsed.heading : undefined,
      body: typeof parsed.body === "string" ? parsed.body : undefined,
    };
  } catch {
    return null;
  }
}

function buildBeatPrompt(group: Turn[]): string {
  // One slice of the session: the opening request(s) plus my work. Sample the
  // assistant text so a dense slice stays within budget.
  const sections = group.map((t) => {
    const assistant = sampleEvenly(t.assistant, 6).map((a) => clip(a, 500)).join("\n");
    return `User: ${clip(t.prompt || "[continued]", 600)}\n${assistant ? "Me:\n" + assistant : ""}`;
  });
  return `Below is one slice of a coding session — the user's request(s) and my work in response ("Me"). Retell it as ONE beat of a first-person story, in my own voice and tone.

Return JSON: {"heading": "...", "body": "..."}
- heading: 3-6 words naming what this slice was about.
- body: 2-4 sentences covering what I set out to do here and what actually happened — keep concrete file/feature names, decisions, and outcomes. Light markdown (inline \`code\`, **bold**) is fine. No headers, no lists.
- VOICE: always first person, from MY perspective as the one doing the work ("I traced…", "I fixed…"). The narration is mine throughout — never narrate the user in third person, never open with "The user". If a request matters, fold it in as "I was asked to…" or "X came up, so I…".

Do not add any preamble or tags. Output ONLY the JSON object.

<slice>
${sections.join("\n\n")}
</slice>`;
}

function buildPhasePrompt(beats: Beat[]): string {
  const text = beats.map((b) => `## ${b.heading}\n${b.body}`).join("\n\n");
  return `Below are several beats of a coding session's story, in order, written in my first-person voice. Combine them into ONE higher-level phase of the session.

Return JSON: {"heading": "...", "body": "..."}
- heading: 3-6 words naming this phase of the work.
- body: 2-3 sentences, same first-person voice, describing the arc across these beats at a higher level — the goal and the throughline, not every step. Light markdown is fine. No headers, no lists.

Do not add any preamble or tags. Output ONLY the JSON object.

<beats>
${text}
</beats>`;
}

async function mapBeats<T>(
  items: T[][],
  buildPrompt: (group: T[]) => string,
  apiKey: string,
  anchorOf: (group: T[]) => { anchor_prompt: string; anchor_message_id: string; anchor_timestamp: number },
): Promise<Beat[]> {
  const out: Beat[] = new Array(items.length);
  for (let i = 0; i < items.length; i += HAIKU_BATCH) {
    const slice = items.slice(i, i + HAIKU_BATCH);
    await Promise.all(
      slice.map(async (group, j) => {
        const idx = i + j;
        const anchor = anchorOf(group);
        try {
          const text = await callHaiku(apiKey, buildPrompt(group), 700);
          const parsed = text ? extractBeatJson(text) : null;
          out[idx] = {
            heading: parsed?.heading?.trim() || "",
            body: parsed?.body?.trim() || "",
            ...anchor,
          };
        } catch (err) {
          console.error("storyMode beat failed:", err);
          out[idx] = { heading: "", body: "", ...anchor };
        }
      })
    );
  }
  return out.filter((b) => b && b.body);
}

// ── Generation actions ───────────────────────────────────────────────────────

export const generateStory = action({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<{ ok: boolean; beats: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false, beats: 0 };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.error("ANTHROPIC_API_KEY not configured"); return { ok: false, beats: 0 }; }

    const input = await ctx.runQuery(internal.storyMode.getStoryInput, { conversation_id: args.conversation_id, user_id: userId });
    if (!input || input.turns.length === 0) return { ok: false, beats: 0 };

    const groups = chunkInto(input.turns, beatCount(input.turns.length));
    const beats = await mapBeats(groups, buildBeatPrompt, apiKey, (g) => ({
      anchor_prompt: g[0].prompt,
      anchor_message_id: g[0].promptId,
      anchor_timestamp: g[0].promptTs,
    }));
    if (beats.length === 0) return { ok: false, beats: 0 };

    await ctx.runMutation(internal.storyMode.writeLevel, {
      conversation_id: args.conversation_id,
      level: "story",
      json: JSON.stringify(beats),
      message_count: input.message_count,
      generated_at: Date.now(),
    });
    return { ok: true, beats: beats.length };
  },
});

export const generateSummary = action({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args): Promise<{ ok: boolean; phases: number }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { ok: false, phases: 0 };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { console.error("ANTHROPIC_API_KEY not configured"); return { ok: false, phases: 0 }; }

    // Summary is built FROM the story beats. Ensure they exist first.
    let cached = await ctx.runQuery(internal.storyMode.getCachedStory, { conversation_id: args.conversation_id, user_id: userId });
    if (!cached || cached.beats.length === 0) {
      await ctx.runAction(internal.storyMode.generateStoryInternal, { conversation_id: args.conversation_id, user_id: userId });
      cached = await ctx.runQuery(internal.storyMode.getCachedStory, { conversation_id: args.conversation_id, user_id: userId });
    }
    if (!cached || cached.beats.length === 0) return { ok: false, phases: 0 };

    const groups = chunkInto(cached.beats, phaseCount(cached.beats.length));
    const phases = await mapBeats(groups, buildPhasePrompt, apiKey, (g) => ({
      anchor_prompt: g[0].anchor_prompt,
      anchor_message_id: g[0].anchor_message_id,
      anchor_timestamp: g[0].anchor_timestamp,
    }));
    if (phases.length === 0) return { ok: false, phases: 0 };

    await ctx.runMutation(internal.storyMode.writeLevel, {
      conversation_id: args.conversation_id,
      level: "summary",
      json: JSON.stringify(phases),
      message_count: cached.message_count,
      generated_at: Date.now(),
    });
    return { ok: true, phases: phases.length };
  },
});

// Internal twin of generateStory so generateSummary can ensure beats exist
// without a second auth round-trip (it already holds the verified user id).
export const generateStoryInternal = internalAction({
  args: { conversation_id: v.id("conversations"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false };
    const input = await ctx.runQuery(internal.storyMode.getStoryInput, { conversation_id: args.conversation_id, user_id: args.user_id });
    if (!input || input.turns.length === 0) return { ok: false };
    const groups = chunkInto(input.turns, beatCount(input.turns.length));
    const beats = await mapBeats(groups, buildBeatPrompt, apiKey, (g) => ({
      anchor_prompt: g[0].prompt,
      anchor_message_id: g[0].promptId,
      anchor_timestamp: g[0].promptTs,
    }));
    if (beats.length === 0) return { ok: false };
    await ctx.runMutation(internal.storyMode.writeLevel, {
      conversation_id: args.conversation_id,
      level: "story",
      json: JSON.stringify(beats),
      message_count: input.message_count,
      generated_at: Date.now(),
    });
    return { ok: true };
  },
});
