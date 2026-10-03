import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { isMachineDeliveredMessage, stripMentionContext } from "@codecast/shared/contracts";
import { isStickyEligible, stickyPromptContent } from "../../../web/lib/stickyPrompt";

// Human-send detection + the per-day counters behind the "Typed" and "Words"
// chart metrics. A send is a user-role message a person typed as their own
// ask: it clears the noise classifier here (shared with the profile feed) AND
// the sticky filter the prompt header uses, which also drops bare nudges
// ("continue", "ok"), client commands and spawned briefings. Those are what a
// machine queues on a person's behalf, and nothing on the row tells the two
// apart.

const NOISE_PREFIXES = [
  "[Request interrupted",
  "This session is being continued",
  "Your task is to create a detailed summary",
  "Full transcript available at:",
  "Read the output file to retrieve the result:",
  "[Codecast import]",
  // The CLI's injected session-move notice (sessionMoveNotice.ts).
  "[codecast]",
];
const COMMAND_RE = /^(<command-name>|<command-message>|<local-command-stdout>|<local-command-stderr>|Caveat:|\/[a-z][\w-]*)/i;
const SKILL_RE = /Base directory for this skill:\s/;

export function stripMessageTags(s: string): string {
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, "")
    .replace(/<\/?(?:command-(?:name|message|args)|antml:[a-z_]+)[^>]*>/g, "")
    .replace(/^\s*Caveat:.*$/gm, "")
    .trim();
}

export function isUserMessageNoise(content: string): boolean {
  if (!content) return true;
  const t = content.trim();
  if (!t) return true;
  // Machine-delivered user-role turns — cast send session messages, inter-agent
  // teammate broadcasts (with or without <teammate-message> tags), scheduled-task
  // injections, team-chat anchor wakes. Agent coordination, not something the
  // human typed into this session — drop them from "what I wrote".
  if (isMachineDeliveredMessage(t)) return true;
  if (COMMAND_RE.test(t)) return true;
  if (SKILL_RE.test(t)) return true;
  if (t.startsWith("{") && t.includes("__cc_poll")) return true;
  if (t.includes("Your task is to create a detailed summary of the conversation so far")) return true;
  const stripped = stripMessageTags(t);
  if (!stripped) return true;
  if (NOISE_PREFIXES.some((p) => stripped.startsWith(p))) return true;
  return false;
}

// A pasted block is in the message but was not typed.
const PASTED_BLOCK_RE = /<pasted_content(?=[\s>])[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g;

// The words a person typed in a user-role message, or null when the message
// is not a send. A message that is only a paste is a send of zero words.
export function typedWords(content: string | undefined): number | null {
  if (!content || isUserMessageNoise(content) || !isStickyEligible(content)) return null;
  const typed = stickyPromptContent(stripMentionContext(content.replace(PASTED_BLOCK_RE, "")));
  return typed ? typed.split(/\s+/).filter(Boolean).length : 0;
}

const DAY = 24 * 3600000;
const HOUR = 3600000;

export function dayStartUtc(ts: number): number {
  return Math.floor(ts / DAY) * DAY;
}

type SendMessage = { role: string; content?: string; tool_results?: unknown[] | undefined; from_user_id?: Id<"users"> };
type Send = { user_id: Id<"users">; team_id?: Id<"teams">; words: number };

// Decide whether an inserted user-role message counts as a human send, and if
// so, who sent it. `from_user_id` is stamped only when a pending-message echo
// matched (composer/CLI/team sends); terminal-typed messages carry none and
// belong to the conversation owner. Subagent conversations are excluded — user
// turns there are the parent agent's briefings, not human typing.
export function classifyUserSend(
  conversation: Doc<"conversations">,
  msg: SendMessage,
): Omit<Send, "team_id"> | null {
  if (msg.role !== "user") return null;
  if ((conversation as { parent_conversation_id?: unknown }).parent_conversation_id) return null;
  if (msg.tool_results && msg.tool_results.length > 0) return null;
  const words = typedWords(msg.content);
  return words === null ? null : { user_id: msg.from_user_id ?? conversation.user_id, words };
}

// Team attribution follows ROUTING: conversations are often created teamless
// and restamped later, so the stored team_id alone under-attributes. Fall back
// to the owner's active team, the same rule routing uses elsewhere.
async function resolveSendTeam(
  ctx: { db: any },
  conversation: Doc<"conversations">,
): Promise<Id<"teams"> | undefined> {
  if (conversation.team_id) return conversation.team_id;
  const owner = await ctx.db.get(conversation.user_id);
  return owner?.active_team_id ?? owner?.team_id ?? undefined;
}

async function resolveUserSend(ctx: { db: any }, conversation: Doc<"conversations">, msg: SendMessage): Promise<Send | null> {
  const send = classifyUserSend(conversation, msg);
  return send ? { ...send, team_id: await resolveSendTeam(ctx, conversation) } : null;
}

export async function scheduleUserSend(
  ctx: { db: any; scheduler: any },
  conversation: Doc<"conversations">,
  msg: SendMessage,
  timestamp: number,
): Promise<boolean> {
  const send = await resolveUserSend(ctx, conversation, msg);
  if (!send) return false;
  await ctx.scheduler.runAfter(0, internal.userSends.record, { ...send, timestamp });
  return true;
}

export async function maybeRecordUserSend(
  ctx: { db: any },
  conversation: Doc<"conversations">,
  msg: SendMessage,
  timestamp: number,
): Promise<boolean> {
  const send = await resolveUserSend(ctx, conversation, msg);
  if (!send) return false;
  await recordUserSend(ctx, send, timestamp);
  return true;
}

// A counter row under the current rule carries word counts. Rows written
// before words existed counted by an older rule; they are skipped everywhere
// and deleted once sendBackfill has rebuilt their days.
const isCurrent = (r: { word_hours?: number[] }) => !!r.word_hours;

// Bump the (user, team, UTC day) counter row.
export async function recordUserSend(ctx: { db: any }, send: Send, timestamp: number): Promise<void> {
  const day = dayStartUtc(timestamp);
  const hour = Math.min(23, Math.max(0, Math.floor((timestamp - day) / HOUR)));
  const rows = await ctx.db
    .query("user_send_daily")
    .withIndex("by_user_team_day", (q: any) =>
      q.eq("user_id", send.user_id).eq("team_id", send.team_id).eq("day_start", day),
    )
    .collect();
  const existing = rows.find(isCurrent);
  if (existing) {
    const hours = [...existing.hours];
    const word_hours = [...existing.word_hours];
    hours[hour] = (hours[hour] || 0) + 1;
    word_hours[hour] = (word_hours[hour] || 0) + send.words;
    await ctx.db.patch(existing._id, {
      total: existing.total + 1,
      hours,
      words: existing.words + send.words,
      word_hours,
      updated_at: Date.now(),
    });
  } else {
    const hours = new Array(24).fill(0);
    const word_hours = new Array(24).fill(0);
    hours[hour] = 1;
    word_hours[hour] = send.words;
    await ctx.db.insert("user_send_daily", {
      user_id: send.user_id,
      team_id: send.team_id,
      day_start: day,
      total: 1,
      hours,
      words: send.words,
      word_hours,
      updated_at: Date.now(),
    });
  }
}

export type SendDayRow = { day_start: number; total: number; hours: number[]; words: number; word_hours: number[] };

// Read a user's send counters over a trailing window, optionally scoped to one
// team. Unscoped reads sum every team row (a user's sends can span teams and
// personal work in one day). ≤ a few rows per active day — cheap for a year.
export async function fetchUserSendDays(
  ctx: { db: any },
  userId: Id<"users">,
  teamId: Id<"teams"> | undefined,
  days: number,
): Promise<SendDayRow[]> {
  const cutoff = dayStartUtc(Date.now() - days * DAY);
  if (teamId) {
    const rows = await ctx.db
      .query("user_send_daily")
      .withIndex("by_user_team_day", (q: any) =>
        q.eq("user_id", userId).eq("team_id", teamId).gte("day_start", cutoff),
      )
      .collect();
    return rows.filter(isCurrent);
  }
  const rows: SendDayRow[] = await ctx.db
    .query("user_send_daily")
    .withIndex("by_user_day", (q: any) => q.eq("user_id", userId).gte("day_start", cutoff))
    .collect();
  // Merge team + personal rows that share a day.
  const byDay = new Map<number, SendDayRow>();
  for (const r of rows.filter(isCurrent)) {
    const acc = byDay.get(r.day_start);
    if (!acc) {
      byDay.set(r.day_start, { day_start: r.day_start, total: r.total, hours: [...r.hours], words: r.words, word_hours: [...r.word_hours] });
    } else {
      acc.total += r.total;
      acc.words += r.words;
      for (let h = 0; h < 24; h++) {
        acc.hours[h] += r.hours[h] || 0;
        acc.word_hours[h] += r.word_hours[h] || 0;
      }
    }
  }
  return [...byDay.values()];
}
