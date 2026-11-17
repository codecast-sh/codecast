// What became of each composer suggestion (the ghost reply in the empty
// composer, composerSuggestions.ts): the client reports it, the suggester
// reads the newest back, and `funnel` turns the log into a take rate. Its own
// module because it writes suggestion_outcomes, not the composer_suggestions
// rows the client store holds.
import { internalQuery, mutation } from "./functions";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { vendorRefusalFromDb } from "./lib/vendorGuard";
import { stripInjectionNoise } from "@codecast/shared/contracts";
import { parseJointMessage } from "@codecast/shared/contracts/jointMessage";
import { isMachineCarrierText, type SuggestionOutcome } from "./composerSuggestions";
import { outcomeArgs, suggestionsProvider, writeSuggestionOutcome } from "./lib/suggestionOutcomeWrite";

// Recent outcomes the suggester reads back, newest first.
const OUTCOMES_FOR_PROMPT = 12;

// Client-reported fate of the suggestion shown for one agent turn
// (lib/suggestionOutcomeWrite holds the write and its owner gate).
export const record = mutation({
  args: outcomeArgs,
  handler: async (ctx, args) => writeSuggestionOutcome(ctx, args),
});

// The composer take rate, from the outcome log: per person and ISO week, of
// the replies typed in the codecast composer while a suggestion was on show,
// how many took it. Replies from a terminal, a decision card, or a client
// that was not showing the suggestion are not in it, so it reads high for
// people who answer elsewhere. Only rows that carry `shown` count, so the
// rate starts with the clients that report "ignored".
// `npx convex run suggestionOutcomes:funnel '{"since_days":14}'`
export function funnelOf(rows: Array<{ user_id: string; outcome: string; shown?: string[]; created_at: number }>) {
  const out = new Map<string, { user: string; week: string; replied: number; sent: number; edited: number; ignored: number }>();
  for (const r of rows) {
    if (!r.shown) continue;
    const d = new Date(r.created_at);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    const week = monday.toISOString().slice(0, 10);
    const key = `${r.user_id}|${week}`;
    const row = out.get(key) ?? { user: String(r.user_id), week, replied: 0, sent: 0, edited: 0, ignored: 0 };
    row.replied++;
    if (r.outcome === "sent" || r.outcome === "edited") row[r.outcome]++;
    else row.ignored++;
    out.set(key, row);
  }
  return [...out.values()]
    .sort((a, b) => (a.week === b.week ? a.user.localeCompare(b.user) : a.week.localeCompare(b.week)))
    .map((r) => ({ ...r, composer_take_rate: r.replied ? Math.round(((r.sent + r.edited) / r.replied) * 100) / 100 : 0 }));
}

export const funnel = internalQuery({
  args: { since_days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const since = Date.now() - (args.since_days ?? 28) * 86_400_000;
    const rows = await ctx.db
      .query("suggestion_outcomes")
      .withIndex("by_created", (q) => q.gte("created_at", since))
      .collect();
    return funnelOf(rows as any);
  },
});

// The newest outcomes, each with what the developer sent instead when they
// rewrote or passed over the suggestion. That reply is read from the
// transcript (the first user row after the anchor), never stored with the
// outcome: a deleted or redacted session takes it along. A regulated team's
// conversation stays out, as in composerSuggestions.getRecentUserInputs, because this goes to the
// suggester's vendor. Rows from before `shown` existed carry no ignored
// record, so they are left out rather than read as a stream of takes.
export const recent = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args): Promise<SuggestionOutcome[]> => {
    const rows = await ctx.db
      .query("suggestion_outcomes")
      .withIndex("by_user_created", (q) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(OUTCOMES_FOR_PROMPT * 3);
    const refused = new Map<string, boolean>();
    const out: SuggestionOutcome[] = [];
    for (const r of rows) {
      if (out.length >= OUTCOMES_FOR_PROMPT) break;
      if (!r.shown || r.outcome === "dismissed") continue;
      const conv = String(r.conversation_id);
      if (!refused.has(conv)) refused.set(conv, !!(await vendorRefusalFromDb(ctx, { conversationId: r.conversation_id }, suggestionsProvider())));
      if (refused.get(conv)) continue;
      const outcome = r.outcome as SuggestionOutcome["outcome"];
      if (outcome === "sent") {
        out.push({ outcome, suggestion: r.suggestion });
        continue;
      }
      const reply = await replyAfter(ctx, r.conversation_id, r.anchor_message_uuid, r.typed_length);
      // Gone (deleted, redacted, encrypted) or not words they typed: the
      // outcome has nothing to teach without it.
      if (reply) out.push({ outcome, suggestion: r.suggestion, reply });
    }
    return out;
  },
});

// What the developer typed in the first message after the agent turn
// `anchor` (a message_uuid, or a message id for rows that have none), or null.
// The message can carry more than their words: quotes and proposal answers
// the composer folded in ahead of them, or other people's parts of a joint
// send. A joint send gives their own part (the composer puts it first);
// otherwise `typedLength` keeps their words, which the composer appends last.
// Without it (rows from older clients) a message holding a quote is skipped.
async function replyAfter(ctx: any, conversationId: Id<"conversations">, anchor: string, typedLength?: number): Promise<string | null> {
  const byUuid = await ctx.db
    .query("messages")
    .withIndex("by_conversation_uuid", (q: any) => q.eq("conversation_id", conversationId).eq("message_uuid", anchor))
    .first();
  const id = byUuid ? null : ctx.db.normalizeId("messages", anchor);
  const at = byUuid ?? (id ? await ctx.db.get(id) : null);
  if (!at || String(at.conversation_id) !== String(conversationId)) return null;
  const next = await ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q.eq("conversation_id", conversationId).eq("role", "user").gt("timestamp", at.timestamp)
    )
    .filter((q: any) => q.eq(q.field("tool_results"), undefined))
    .first();
  if (!next || next.is_encrypted) return null;
  const typed = typedPart(stripInjectionNoise(next.content ?? ""), typedLength);
  if (!typed || typed.startsWith("/") || /^<command-/.test(typed) || isMachineCarrierText(typed)) return null;
  return typed;
}

/** The person's own words in a sent message's text (see replyAfter). */
export function typedPart(text: string, typedLength?: number): string | null {
  const joint = parseJointMessage(text);
  if (joint) return joint[0]!.body.trim() || null;
  const whole = text.trim();
  if (typedLength && typedLength > 0) return whole.slice(Math.max(0, whole.length - typedLength)).trim() || null;
  return /^ {0,3}>/m.test(whole) ? null : whole || null;
}
