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
export type ChatAgentStatus = "thinking" | "streaming" | "done" | "error";

export type ChatMessageView = {
  id: string;
  author: ChatAuthor;
  /** Markdown. */
  content: string;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  mentionsMe?: boolean;
  reactions?: ChatReaction[];
  agentStatus?: ChatAgentStatus;
  /** Thread rollup, present only on a root message that has replies. */
  replyCount?: number;
  lastReplyAt?: number;
  replyFaces?: { id: string; name: string; avatarUrl?: string; isAgent?: boolean }[];
  /** Optimistic rows render at reduced opacity until the server echoes them. */
  pending?: boolean;
  failed?: boolean;
};

export type ChatChannelView = {
  id: string;
  name: string;
  topic?: string;
  unreadCount?: number;
  /** Mentions of you specifically. This is the count allowed to shout. */
  mentionCount?: number;
  muted?: boolean;
  isPrivate?: boolean;
};
