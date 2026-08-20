// View models for the chat surface.
//
// Deliberately independent of the store row shapes. The presentational
// components take these and nothing else, so they render identically from a
// fixture, from an optimistic stub and from a synced server row — and so the
// whole surface can be designed and screenshot-verified before the store exists.

export type ChatAuthor = {
  id: string;
  name: string;
  avatarUrl?: string;
  /** The anchor and any other standing agent member. Renders with the agent
   *  chip and the violet identity instead of a photo. */
  isAgent?: boolean;
  /** Handle used for @mentions, without the @. */
  handle?: string;
};

export type ChatReaction = {
  emoji: string;
  count: number;
  /** Whether the viewer is one of the reactors — drives the active pill. */
  mine: boolean;
  /** Names for the tooltip, already ordered. */
  names?: string[];
};

/** Lifecycle of an agent's reply, mirroring comments.agent_status so the two
 *  surfaces behave the same way. */
// "listening" / "passed" exist server-side (a silent wake in a followed thread
// and the anchor's choice to stay quiet); the server never returns those rows,
// so a client only ever renders the four visible states.
export type ChatAgentStatus = "thinking" | "streaming" | "done" | "error" | "listening" | "passed";

export type ChatAttachmentView = {
  storage_id: string;
  name?: string;
  mime?: string;
  width?: number;
  height?: number;
};

export type ChatMessageView = {
  id: string;
  author: ChatAuthor;
  /** Markdown. */
  content: string;
  /** Uploaded images, rendered as a grid under the text. */
  attachments?: ChatAttachmentView[];
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  mentionsMe?: boolean;
  reactions?: ChatReaction[];
  agentStatus?: ChatAgentStatus;
  /** Set on a thread REPLY. In the channel timeline it only ever appears on a
   *  broadcast reply ("also send to #channel"), where it drives the small
   *  "replied to a thread" context line that opens the thread. */
  threadRootId?: string;
  /** Thread rollup, present only on a root message that has replies. */
  replyCount?: number;
  lastReplyAt?: number;
  replyFaces?: { id: string; name: string; avatarUrl?: string; isAgent?: boolean }[];
  /** An agent turn in flight (or failed) inside this root's thread, so the
   *  affordance can say "thinking…" without the panel open. */
  threadAgentStatus?: "thinking" | "streaming" | "error";
  /** Optimistic, not yet echoed by the server. Renders like a sent row; the
   *  flag is kept for callers that reason about the outbox. */
  pending?: boolean;
  failed?: boolean;
};

export type ChatChannelView = {
  id: string;
  name: string;
  /** Absent = public. Shapes the icon, the naming, and what the menu offers. */
  kind?: "public" | "private" | "dm";
  /** The OTHER parties of a DM (viewer excluded) — the naming source. */
  dmMemberIds?: string[];
  /** Roster of a restricted room, viewer included (the members panel). */
  memberIds?: string[];
  topic?: string;
  unreadCount?: number;
  /** Mentions of you specifically. This is the count allowed to shout. */
  mentionCount?: number;
  muted?: boolean;
  isPrivate?: boolean;
  /** The channel's team — the mention scope for its composer. */
  teamId?: string;
};
