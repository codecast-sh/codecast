// One row of the mention dropdown (components/editor/MentionList) as the
// libraries that rank and build the rows see it. It lives here, not in the
// component, because lib/mentionRanking and hooks/useMentionQuery are reached
// from mobile (through lib/chatViews), and a type import from a component
// module makes the mobile typecheck load the whole editor.
import type { IdentityRow } from "./sessionIdentity";

export type MentionItem = {
  id: string;
  type: string;
  label: string;
  sublabel?: string;
  /** The @handle this person answers to in team chat — the server's mention
   *  vocabulary (github username, email local part, or a bot's name slug). */
  handle?: string;
  isBot?: boolean;
  /** A person who exists only in the team's Slack workspace: the row wears
   *  the Slack mark, and the send pages them in the line's Slack copy. */
  slack?: boolean;
  image?: string;
  shortId?: string;
  status?: string;
  priority?: string;
  docType?: string;
  messageCount?: number;
  projectPath?: string;
  goal?: string;
  model?: string;
  agentType?: string;
  updatedAt?: number;
  viewedAt?: number;
  idleSummary?: string;
  /** A session's identity row (session-characters.md S1): the character and
   *  role fields, handed whole to `sessionIdentity` so the dropdown row wears
   *  the face and name the inbox card wears. Nothing else reads them. */
  identity?: IdentityRow;
};
