// The vocabulary of a channel mirror: which way it flows, what it carries by
// default, and the words both sides use to say so. Pure — no convex runtime, no
// I/O — so the server (slackSync.ts), the settings dialog and the summary list
// all read one definition instead of three copies that drift.

export type SlackDirection = "both" | "slack_to_codecast" | "codecast_to_slack";

export type SlackSendAuth = "ready" | "connect" | "reconnect";

export function tokenCanPost(scopes: string | undefined | null): boolean {
  return (scopes ?? "").split(",").some((scope) => scope.trim() === "chat:write");
}

export function slackSendAuth(token: { scopes?: string } | null): SlackSendAuth {
  return !token ? "connect" : tokenCanPost(token.scopes) ? "ready" : "reconnect";
}

export type SlackLinkOptions = {
  threads: boolean;
  reactions: boolean;
  edits: boolean;
  files: boolean;
  bot_messages: boolean;
  system_messages: boolean;
  agent_lines: boolean;
  match_people_by_email: boolean;
};

// What a new mirror carries until somebody says otherwise. Conversation first:
// threads, reactions, edits and files on, because a mirror that drops them does
// not read as one room. Other apps' lines on too: in many channels the app IS
// the conversation (a caller assistant, a deploy bot people reply to), and a
// room missing them reads as if it has holes. Slack's own join and topic
// notices off, because they are housekeeping, not talk.
export const LINK_DEFAULTS: SlackLinkOptions = {
  threads: true,
  reactions: true,
  edits: true,
  files: true,
  bot_messages: true,
  system_messages: false,
  agent_lines: true,
  match_people_by_email: true,
};

/** A patch over the controls. Only booleans land, so a malformed value from a
 *  CLI flag or a dispatch payload leaves the stored option alone rather than
 *  writing a non-boolean the reader then has to guess about. The server applies
 *  it to the row and the store applies it to the draft — one merge rule. */
export function mergeLinkOptions(
  base: SlackLinkOptions,
  patch?: Partial<SlackLinkOptions> | null,
): SlackLinkOptions {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (typeof value === "boolean") (out as any)[key] = value;
  }
  return out;
}

/** Only the two fields the direction questions read, so the server's link row
 *  and the store's copy both answer them. */
type Flowing = { direction: SlackDirection; paused?: boolean };

/** Does a line written in codecast reach Slack? */
export function linkSendsOutbound(link: Flowing): boolean {
  return !link.paused && (link.direction === "both" || link.direction === "codecast_to_slack");
}

/** Does a line written in Slack reach codecast? */
export function linkReceivesInbound(link: Flowing): boolean {
  return !link.paused && (link.direction === "both" || link.direction === "slack_to_codecast");
}

/** How much Slack history a new mirror brings over. "none" starts from now;
 *  "all" is bounded by BACKFILL_MAX_TOTAL lines per import (slackSync.ts). */
export type BackfillWindow = "none" | "1d" | "7d" | "30d" | "90d" | "all";

export const BACKFILL_WINDOWS: { key: BackfillWindow; label: string; hint: string }[] = [
  { key: "none", label: "From now", hint: "Nothing older comes over." },
  { key: "1d", label: "Last day", hint: "Yesterday and today." },
  { key: "7d", label: "Last week", hint: "Enough to follow what is being discussed." },
  { key: "30d", label: "Last month", hint: "The usual choice: recent context without the archive." },
  { key: "90d", label: "Last 3 months", hint: "A quarter of history." },
  { key: "all", label: "Everything", hint: "The whole channel, up to 25,000 lines." },
];

/** The default for a channel brought over from Slack: a month gives the room
 *  its recent context without dragging in years of archive. */
export const DEFAULT_BACKFILL: BackfillWindow = "30d";

/** The one word about a mirror's health. Every surface that marks a mirrored
 *  channel (header pill, channel rows, tooltips) reads it from here, so a
 *  paused link looks paused everywhere or nowhere. */
export type SlackMirrorState = "live" | "paused" | "error";

export function mirrorState(link: Flowing & { last_error?: string | null }): SlackMirrorState {
  if (link.paused) return "paused";
  if (link.last_error) return "error";
  return "live";
}

export const MIRROR_STATE_LABEL: Record<SlackMirrorState, string> = {
  live: "Mirrored with Slack",
  paused: "Slack mirror paused",
  error: "Slack mirror needs attention",
};

/** The glyph beside a mirrored pair, everywhere one is named. */
export const DIRECTION_ARROW: Record<SlackDirection, string> = {
  both: "⇄",
  slack_to_codecast: "←",
  codecast_to_slack: "→",
};

/** Two or three words, for a pill or a tooltip. */
export const DIRECTION_LABEL: Record<SlackDirection, string> = {
  both: "both ways",
  slack_to_codecast: "from Slack",
  codecast_to_slack: "to Slack",
};

/** The codecast-side notice: "(…) by Alice." */
export const DIRECTION_FLOW: Record<SlackDirection, string> = {
  both: "both ways",
  slack_to_codecast: "from Slack only",
  codecast_to_slack: "to Slack only",
};

/** The Slack-side notice, written from Slack's point of view. */
export const DIRECTION_SENTENCE: Record<SlackDirection, string> = {
  both: "Messages here appear there and replies come back.",
  slack_to_codecast: "Messages here appear there.",
  codecast_to_slack: "Messages from codecast appear here.",
};
