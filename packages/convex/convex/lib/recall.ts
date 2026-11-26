// Recall.ai, the service whose bots attend meetings on other platforms for
// codecast (Zoom, Google Meet, Microsoft Teams, Webex, GoTo). Everything here
// is pure or a thin fetch, so the rules are testable without Recall: which
// links a bot can join, what we ask Recall for, how its webhooks are verified,
// and how its events read as codecast's call vocabulary. The table and the
// webhook handlers live in meetingBots.ts.
//
// Codecast's own Recall workspace is pay-as-you-go in us-west-2. Keys are
// region scoped: a key from another region fails exactly like a revoked one.

export const RECALL_API_BASE = "https://us-west-2.recall.ai";

export const RECALL_STATUS_PATH = "/api/webhooks/recall";
export const RECALL_REALTIME_PATH = "/api/webhooks/recall/realtime";

export { MEETING_PLATFORM_NAMES, parseMeetingUrl, type MeetingPlatform } from "@codecast/shared/contracts/meetingLinks";
import { parseMeetingUrl, type MeetingPlatform } from "@codecast/shared/contracts/meetingLinks";

// Recall's join and leave defaults are hostile to real meetings. Union's
// production bots measured these (outreach backend spawnRecallBot.ts): the
// 2s everyone_left default drops the bot for good when the only other person
// blips out, and a bot sent early to an empty room must outlast a late start.
export const BOT_EVERYONE_LEFT_TIMEOUT_S = 600;
export const BOT_NOONE_JOINED_TIMEOUT_S = 1800;

export const BOT_NAME = "Codecast Notetaker";

/** Bot creation body. `meetId` rides as metadata so every webhook names the
 *  meeting_bots row it belongs to without a lookup by Recall's id racing the
 *  create's own answer. */
export function recallBotBody(args: {
  meetId: string;
  meetingUrl: string;
  siteUrl: string;
  botName?: string;
  joinAt?: number;
}): Record<string, unknown> {
  return {
    meeting_url: args.meetingUrl,
    bot_name: (args.botName || BOT_NAME).slice(0, 100),
    ...(args.joinAt ? { join_at: new Date(args.joinAt).toISOString() } : {}),
    automatic_leave: {
      everyone_left_timeout: { timeout: BOT_EVERYONE_LEFT_TIMEOUT_S },
      noone_joined_timeout: BOT_NOONE_JOINED_TIMEOUT_S,
    },
    recording_config: {
      transcript: {
        provider: {
          // The default mode (prioritize_accuracy) holds lines back by
          // minutes; low latency lands each finished line in seconds at the
          // same price. English only.
          recallai_streaming: { language_code: "en", mode: "prioritize_low_latency" },
        },
        // One audio stream per speaker where the platform offers it, so who
        // said what is the platform's fact rather than a guess.
        diarization: { use_separate_streams_when_available: true },
      },
      realtime_endpoints: [
        {
          type: "webhook",
          url: `${args.siteUrl.replace(/\/$/, "")}${RECALL_REALTIME_PATH}`,
          events: ["transcript.data", "participant_events.join", "participant_events.chat_message"],
        },
      ],
    },
    metadata: { meet_id: args.meetId },
  };
}

export type MeetingBotStatus =
  | "requested"
  | "scheduled"
  | "joining"
  | "waiting_room"
  | "in_call"
  | "recording"
  | "ended"
  | "failed"
  | "cancelled";

/** Statuses after which nothing more happens to a bot. */
export const MEETING_BOT_FINAL: ReadonlySet<MeetingBotStatus> = new Set(["ended", "failed", "cancelled"]);

/** A Recall status webhook event as our status, or null for events that do
 *  not change it (breakout rooms, permission granted). `bot.call_ended` is
 *  the end of the call; `bot.done` only says media is ready afterwards. */
export function statusFromRecallEvent(event: string): MeetingBotStatus | null {
  switch (event) {
    case "bot.joining_call":
      return "joining";
    case "bot.in_waiting_room":
      return "waiting_room";
    case "bot.in_call_not_recording":
      return "in_call";
    case "bot.in_call_recording":
      return "recording";
    case "bot.call_ended":
    case "bot.done":
      return "ended";
    case "bot.fatal":
    case "bot.recording_permission_denied":
      return "failed";
    default:
      return null;
  }
}

/** Recall's sub_code in words a person reads on the call row. Codes are not
 *  a closed set, so anything unknown is shown as Recall's own words. */
export function recallSubCodeWords(subCode: string | null | undefined): string | undefined {
  if (!subCode) return undefined;
  const known: Record<string, string> = {
    call_ended_by_host: "The host ended the meeting.",
    call_ended_by_platform_idle: "The meeting platform closed the idle meeting.",
    call_ended_by_platform_max_length: "The meeting hit the platform's length limit.",
    call_ended_by_platform_waiting_room_timeout: "Nobody let the bot in from the waiting room.",
    timeout_exceeded_waiting_room: "Nobody let the bot in from the waiting room.",
    timeout_exceeded_noone_joined: "Nobody joined the meeting.",
    timeout_exceeded_everyone_left: "Everyone left the meeting.",
    timeout_exceeded_silence_detected: "The meeting was silent for an hour.",
    timeout_exceeded_only_bots_detected_using_participant_events: "Only bots were left in the meeting.",
    bot_kicked_from_call: "Someone removed the bot from the meeting.",
    bot_kicked_from_waiting_room: "The bot was turned away from the waiting room.",
    bot_received_leave_call: "The bot was told to leave.",
    meeting_not_found: "The meeting link did not lead to a meeting.",
    meeting_not_started: "The meeting had not started.",
    meeting_requires_sign_in: "The meeting only lets signed-in accounts join.",
    meeting_link_expired: "The meeting link has expired.",
    meeting_link_invalid: "The meeting link is not valid.",
    meeting_password_incorrect: "The meeting password in the link was wrong.",
    meeting_locked: "The meeting was locked.",
    meeting_full: "The meeting was full.",
    zoom_local_recording_request_denied_by_host: "The host refused to let the bot record.",
    zoom_local_recording_disabled: "Recording is turned off for this Zoom account.",
    recording_permission_denied: "The host refused to let the bot record.",
  };
  return known[subCode] ?? subCode.replace(/_/g, " ");
}

// How long one chat message may be on each platform a bot can post in.
// Webex and GoTo give bots no chat.
const CHAT_LIMIT: Partial<Record<MeetingPlatform, number>> = {
  zoom: 4096,
  google_meet: 500,
  microsoft_teams: 4096,
};

/** An agent's reply as one chat message in the meeting: markdown reduced to
 *  the plain text a meeting chat shows, cut at a word near the platform's
 *  limit. Null where the platform gives bots no chat or nothing is left. */
export function meetingChatText(text: string, platform: string): string | null {
  const limit = CHAT_LIMIT[platform as MeetingPlatform];
  if (!limit) return null;
  const plain = (text ?? "")
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!plain) return null;
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > limit * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

export type RecallParticipant = {
  id: number | string;
  name?: string | null;
  email?: string | null;
  is_host?: boolean | null;
};

/** The speaker id a Recall participant is filed under on the call record
 *  when no teammate matched them: stable per bot, so one person speaking
 *  twice is one entry in the roster. */
export function recallSpeakerId(botId: string, participant: RecallParticipant): string {
  return `recall:${botId}:${participant.id}`;
}

/** A transcript.data event's words as one call line, timed on the call's
 *  clock (ms since the transcript began). `offsetMs` is how far into Recall's
 *  recording the transcript began, since Recall times words from the start of
 *  its own recording. Null when there are no words. */
export function lineFromTranscriptData(
  data: { words?: Array<{ text?: string; start_timestamp?: { relative?: number } | null; end_timestamp?: { relative?: number } | null }> },
  offsetMs: number,
): { text: string; t0: number; t1: number } | null {
  const words = (data.words ?? []).filter((w) => (w.text ?? "").trim());
  if (!words.length) return null;
  const text = words.map((w) => w.text!.trim()).join(" ").replace(/\s+([,.!?;:])/g, "$1");
  const start = words[0].start_timestamp?.relative ?? 0;
  const last = words[words.length - 1];
  const end = last.end_timestamp?.relative ?? last.start_timestamp?.relative ?? start;
  const t0 = Math.max(0, Math.round(start * 1000) - offsetMs);
  return { text, t0, t1: Math.max(t0, Math.round(end * 1000) - offsetMs) };
}

// ── Request verification ───────────────────────────────────────────────────
//
// Recall signs every webhook, real-time webhook and websocket upgrade with
// the workspace verification secret, Standard Webhooks style: HMAC-SHA256 of
// `${webhook-id}.${webhook-timestamp}.${body}` keyed by the base64 part of a
// `whsec_` secret, sent as space-separated `v1,<base64>` signatures. Older
// Svix endpoints send the same scheme under svix-* headers.

export const RECALL_SIGNATURE_TOLERANCE_S = 5 * 60;

function header(headers: Headers, name: string): string | null {
  return headers.get(`webhook-${name}`) ?? headers.get(`svix-${name}`);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let bin = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function recallSignature(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return bytesToBase64(sig);
}

/** Whether a request really came from Recall: a valid signature over this
 *  body, made within the tolerance window (a captured request replayed later
 *  fails). Returns the message id, which a handler may use to dedupe. */
export async function verifyRecallRequest(args: {
  secret: string | undefined;
  headers: Headers;
  body: string;
  nowMs?: number;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  if (!args.secret || !args.secret.startsWith("whsec_")) return { ok: false, reason: "no verification secret configured" };
  const id = header(args.headers, "id");
  const timestamp = header(args.headers, "timestamp");
  const signatures = header(args.headers, "signature");
  if (!id || !timestamp || !signatures) return { ok: false, reason: "unsigned request" };
  const ts = Number(timestamp);
  const now = (args.nowMs ?? Date.now()) / 1000;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > RECALL_SIGNATURE_TOLERANCE_S) return { ok: false, reason: "stale signature" };
  const expected = await recallSignature(args.secret, id, timestamp, args.body);
  const match = signatures
    .split(" ")
    .map((s) => s.split(",")[1] ?? "")
    .some((s) => constantTimeEqual(s, expected));
  return match ? { ok: true, id } : { ok: false, reason: "bad signature" };
}

// ── API calls ──────────────────────────────────────────────────────────────

export type RecallResult<T> =
  | { ok: true; data: T }
  // `retry`: the failure may pass (no warm bot free this minute, a 5xx, a rate
  // limit), so the same request is worth asking again shortly.
  | { ok: false; status: number; retry: boolean; error: string };

export async function recallFetch<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<RecallResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${RECALL_API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Token ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (e) {
    return { ok: false, status: 0, retry: true, error: e instanceof Error ? e.message : String(e) };
  }
  const text = await res.text();
  if (res.ok) {
    try {
      return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
    } catch {
      return { ok: true, data: {} as T };
    }
  }
  const retry = res.status === 507 || res.status === 429 || res.status >= 500;
  return { ok: false, status: res.status, retry, error: text.slice(0, 500) || res.statusText };
}

// ── Calendar events ────────────────────────────────────────────────────────

/** A Google Calendar event as the events.list API returns it, the fields a
 *  bot needs. */
export type GoogleCalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  location?: string;
  description?: string;
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
};

/** The meeting a bot can join for a calendar event, or null: an all-day
 *  event, a cancelled one, one the person declined, or one with no link to
 *  a platform a bot can join. The link is looked for where calendars put it:
 *  the Meet link, the conference entry points, then any URL in the location
 *  or description (Zoom, Teams and Webex invites paste theirs there). */
export function meetingOfEvent(e: GoogleCalendarEvent): { url: string; platform: MeetingPlatform; starts_at: number; ends_at: number; title: string } | null {
  if (e.status === "cancelled" || !e.start?.dateTime || !e.end?.dateTime) return null;
  if (e.attendees?.some((a) => a.self && a.responseStatus === "declined")) return null;
  const candidates = [
    e.hangoutLink,
    ...(e.conferenceData?.entryPoints ?? []).filter((p) => p.entryPointType === "video").map((p) => p.uri),
    // The description is often HTML: the pattern stops at quotes and angle
    // brackets, so a link inside an href is found as it stands.
    ...`${e.location ?? ""} ${e.description ?? ""}`.match(/https?:\/\/[^\s"'<>)]+/g) ?? [],
  ];
  for (const c of candidates) {
    if (!c) continue;
    const parsed = parseMeetingUrl(c);
    if (parsed.ok) {
      return {
        url: parsed.url,
        platform: parsed.platform,
        starts_at: Date.parse(e.start.dateTime),
        ends_at: Date.parse(e.end.dateTime),
        title: (e.summary ?? "").trim() || "Untitled meeting",
      };
    }
  }
  return null;
}
