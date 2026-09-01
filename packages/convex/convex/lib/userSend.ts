import type { Doc, Id } from "../_generated/dataModel";
import { isMachineDeliveredMessage } from "@codecast/shared/contracts";

// Human-send detection + the per-day send counters behind the "Sends" chart
// metric. A "send" is a user-role message a person actually typed — the same
// definition the profile feed uses for its default "Typed" view. The noise
// classifier here is the single source of truth; users.ts (profile feed) and
// messages.ts (insert-time counting) both import it.

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

const DAY = 24 * 3600000;
const HOUR = 3600000;

export function dayStartUtc(ts: number): number {
  return Math.floor(ts / DAY) * DAY;
}

// Decide whether an inserted user-role message counts as a human send, and if
// so, who sent it. `from_user_id` is stamped only when a pending-message echo
// matched (composer/CLI/team sends); terminal-typed messages carry none and
// belong to the conversation owner. Subagent conversations are excluded — user
// turns there are the parent agent's briefings, not human typing.
export function classifyUserSend(
  conversation: Doc<"conversations">,
  msg: { role: string; content?: string; tool_results?: unknown[] | undefined; from_user_id?: Id<"users"> },
): { user_id: Id<"users"> } | null {
  if (msg.role !== "user") return null;
  if ((conversation as { parent_conversation_id?: unknown }).parent_conversation_id) return null;
  if (msg.tool_results && msg.tool_results.length > 0) return null;
  if (!msg.content || isUserMessageNoise(msg.content)) return null;
  return { user_id: msg.from_user_id ?? conversation.user_id };
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

// The single entry point: classify the message, resolve team attribution, bump
// the counter. Both insert paths in messages.ts and the backfill call this.
export async function maybeRecordUserSend(
  ctx: { db: any },
  conversation: Doc<"conversations">,
  msg: { role: string; content?: string; tool_results?: unknown[] | undefined; from_user_id?: Id<"users"> },
  timestamp: number,
): Promise<boolean> {
  const send = classifyUserSend(conversation, msg);
  if (!send) return false;
  const team_id = await resolveSendTeam(ctx, conversation);
  await recordUserSend(ctx, { user_id: send.user_id, team_id }, timestamp);
  return true;
}

// Bump the (user, team, UTC day) counter row. One tiny doc per user-day-team;
// human typing rates make write contention a non-issue.
export async function recordUserSend(
  ctx: { db: any },
  send: { user_id: Id<"users">; team_id: Id<"teams"> | undefined },
  timestamp: number,
): Promise<void> {
  const day = dayStartUtc(timestamp);
  const hour = Math.min(23, Math.max(0, Math.floor((timestamp - day) / HOUR)));
  const existing = await ctx.db
    .query("user_send_daily")
    .withIndex("by_user_team_day", (q: any) =>
      q.eq("user_id", send.user_id).eq("team_id", send.team_id).eq("day_start", day),
    )
    .first();
  if (existing) {
    const hours = [...existing.hours];
    hours[hour] = (hours[hour] || 0) + 1;
    await ctx.db.patch(existing._id, { total: existing.total + 1, hours, updated_at: Date.now() });
  } else {
    const hours = new Array(24).fill(0);
    hours[hour] = 1;
    await ctx.db.insert("user_send_daily", {
      user_id: send.user_id,
      team_id: send.team_id,
      day_start: day,
      total: 1,
      hours,
      updated_at: Date.now(),
    });
  }
}

export type SendDayRow = { day_start: number; total: number; hours: number[] };

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
    return await ctx.db
      .query("user_send_daily")
      .withIndex("by_user_team_day", (q: any) =>
        q.eq("user_id", userId).eq("team_id", teamId).gte("day_start", cutoff),
      )
      .collect();
  }
  const rows: SendDayRow[] = await ctx.db
    .query("user_send_daily")
    .withIndex("by_user_day", (q: any) => q.eq("user_id", userId).gte("day_start", cutoff))
    .collect();
  // Merge team + personal rows that share a day.
  const byDay = new Map<number, SendDayRow>();
  for (const r of rows) {
    const acc = byDay.get(r.day_start);
    if (!acc) {
      byDay.set(r.day_start, { day_start: r.day_start, total: r.total, hours: [...r.hours] });
    } else {
      acc.total += r.total;
      for (let h = 0; h < 24; h++) acc.hours[h] += r.hours[h] || 0;
    }
  }
  return [...byDay.values()];
}
