// The vocabulary of a channel mirror: which way it flows, what it carries by
// default, and the words both sides use to say so. Pure — no convex runtime, no
// I/O — so the server (slackSync.ts), the settings dialog and the summary list
// all read one definition instead of three copies that drift.

export type SlackDirection = "both" | "slack_to_codecast" | "codecast_to_slack";

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
// not read as one room. Other apps' posts and Slack's own join and topic
// notices off, because they are noise in a room that did not ask for them.
export const LINK_DEFAULTS: SlackLinkOptions = {
  threads: true,
  reactions: true,
  edits: true,
  files: true,
  bot_messages: false,
  system_messages: false,
  agent_lines: true,
  match_people_by_email: true,
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
