import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { isMachineDeliveredMessage, isTestArtifactPath, stripMentionContext } from "@codecast/shared/contracts";
import { isStickyEligible, stickyPromptContent } from "../../../web/lib/stickyPrompt";
import { commandExpansionName } from "../../../web/lib/conversationProcessor";

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

// `queued` says who put the message in the session's queue, when it came
// through one: a person (the composer, `cast send` from a terminal) or a
// program acting in their name (a spawn brief, an account-switch "continue").
// Unset for a message that arrived only in the transcript: typed at the
// terminal, or handed to the agent as its opening prompt.
type SendMessage = {
  _id?: Id<"messages">;
  role: string;
  content?: string;
  tool_results?: unknown[] | undefined;
  from_user_id?: Id<"users">;
  queued?: "person" | "program";
};
type Send = { user_id: Id<"users">; team_id?: Id<"teams">; words: number };

export function queuedBy(pending: { human?: boolean } | null | undefined): SendMessage["queued"] {
  return pending ? (pending.human ? "person" : "program") : undefined;
}

// A session a program started: a subagent, a spawned worker, a workflow or
// trigger run, a headless `claude -p`, or a codecast test run that reached a
// real account before the CLI refused them. Its opening prompt and whatever
// lands in its terminal were written by the launcher, so only a message a
// person queued into it is theirs.
export function isProgramLaunched(conversation: Doc<"conversations">): boolean {
  return !!(
    conversation.parent_conversation_id ||
    conversation.is_subagent ||
    conversation.spawned_by_conversation_id ||
    conversation.workflow_run_id ||
    conversation.agent_task_id ||
    conversation.cli_flags?.includes("--print") ||
    isTestArtifactPath(conversation.project_path ?? "")
  );
}

// Decide whether a user-role message is a person's own send, and if so who
// sent it and how many words they typed. `from_user_id` is the queue's sender
// stamp; a message typed at the terminal carries none and belongs to the
// conversation owner. This half reads the message alone; whether the session
// itself was launched by a program is isProgramLaunched, checked separately
// because those links are stamped seconds after the first message arrives.
export function classifyUserSend(conversation: Doc<"conversations">, msg: SendMessage): Omit<Send, "team_id"> | null {
  if (msg.role !== "user" || msg.queued === "program") return null;
  if (msg.tool_results && msg.tool_results.length > 0) return null;
  const words = typedWords(msg.content);
  return words === null ? null : { user_id: msg.from_user_id ?? conversation.user_id, words };
}

// Team attribution for the per-day counters (sends here, tokens in
// usageDaily.ts) follows ROUTING: conversations are often created teamless
// and restamped later, so the stored team_id alone under-attributes. Fall back
// to the owner's active team, the same rule routing uses elsewhere.
export async function resolveCounterTeam(
  ctx: { db: any },
  conversation: Doc<"conversations">,
): Promise<Id<"teams"> | undefined> {
  if (conversation.team_id) return conversation.team_id;
  const owner = await ctx.db.get(conversation.user_id);
  return owner?.active_team_id ?? owner?.team_id ?? undefined;
}

// Launch links (parent, spawned-by) land up to a minute after a session's
// first message, so the counter waits that long before it reads them.
const LAUNCH_LINK_GRACE_MS = 60_000;

// A slash command's body, which Claude Code writes as its own user turn right
// after the command. The body has no marker of its own: it is recognized by
// following the command (commandExpansionName, the rule the thread folds by).
async function isCommandBody(ctx: { db: any }, conversationId: Id<"conversations">, msg: SendMessage, timestamp: number): Promise<boolean> {
  if (!msg.content || msg.content.trim().length <= 200) return false;
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q.eq("conversation_id", conversationId).eq("role", "user").lte("timestamp", timestamp),
    )
    .order("desc")
    .take(3);
  const prev = recent.find((m: any) => m._id !== msg._id && m.content !== msg.content);
  return !!commandExpansionName(prev, { content: msg.content, timestamp });
}

export async function scheduleUserSend(
  ctx: { db: any; scheduler: any },
  conversation: Doc<"conversations">,
  msg: SendMessage,
  timestamp: number,
): Promise<boolean> {
  const send = classifyUserSend(conversation, msg);
  if (!send || (await isCommandBody(ctx, conversation._id, msg, timestamp))) return false;
  await ctx.scheduler.runAfter(LAUNCH_LINK_GRACE_MS, internal.userSends.record, {
    ...send,
    conversation_id: conversation._id,
    by_person: msg.queued === "person",
    timestamp,
  });
  return true;
}

// Count a classified send, unless a program launched its session and no
// person queued the message.
export async function recordSendFor(
  ctx: { db: any },
  conversation: Doc<"conversations">,
  send: Omit<Send, "team_id">,
  byPerson: boolean,
  timestamp: number,
): Promise<boolean> {
  if (!byPerson && isProgramLaunched(conversation)) return false;
  await recordUserSend(ctx, { ...send, team_id: await resolveCounterTeam(ctx, conversation) }, timestamp);
  return true;
}

export async function maybeRecordUserSend(
  ctx: { db: any },
  conversation: Doc<"conversations">,
  msg: SendMessage,
  timestamp: number,
): Promise<boolean> {
  const send = classifyUserSend(conversation, msg);
  if (!send || (await isCommandBody(ctx, conversation._id, msg, timestamp))) return false;
  return recordSendFor(ctx, conversation, send, msg.queued === "person", timestamp);
}

// Bump the (user, team, UTC day) counter row.
export async function recordUserSend(ctx: { db: any }, send: Send, timestamp: number): Promise<void> {
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
    const word_hours = [...(existing.word_hours ?? new Array(24).fill(0))];
    hours[hour] = (hours[hour] || 0) + 1;
    word_hours[hour] = (word_hours[hour] || 0) + send.words;
    await ctx.db.patch(existing._id, {
      total: existing.total + 1,
      hours,
      words: (existing.words ?? 0) + send.words,
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

export type SendDayRow = { day_start: number; total: number; hours: number[]; words?: number; word_hours?: number[] };

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
  const byDay = new Map<number, SendDayRow & { words: number; word_hours: number[] }>();
  for (const r of rows) {
    const acc = byDay.get(r.day_start) ?? { day_start: r.day_start, total: 0, hours: new Array(24).fill(0), words: 0, word_hours: new Array(24).fill(0) };
    byDay.set(r.day_start, acc);
    acc.total += r.total;
    acc.words += r.words ?? 0;
    for (let h = 0; h < 24; h++) {
      acc.hours[h] += r.hours[h] || 0;
      acc.word_hours[h] += r.word_hours?.[h] || 0;
    }
  }
  return [...byDay.values()];
}
