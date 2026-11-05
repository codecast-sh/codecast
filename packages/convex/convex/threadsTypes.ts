// The Threads inbox's wire shapes (threads.ts): one entry per thread, and the
// rows listMine ships for the cards to render. Web mirrors ThreadInboxEntry in
// store/threadTypes.ts.

import type { Doc, Id } from "./_generated/dataModel";
import type { ConversationComment } from "./lib/conversationCommentRows";
import type { authorsFor, ThreadSummary } from "./chat";
import type { ThreadKind } from "./threadReads";

export type ThreadRead = Doc<"thread_reads">;

export type ThreadLastReply = {
  _id: string;
  user_id?: string;
  author_kind?: "user" | "agent";
  author_name?: string;
  /** An agent's reply names the session it came from, when the viewer may
   *  see that session: the author string is the token owner's name. */
  session_title?: string;
  created_at: number;
  preview: string;
};

export type ThreadInboxEntry = {
  _id: string;
  kind: ThreadKind;
  root_key: string;
  team_id?: string;
  channel_id?: string;
  conversation_id?: string;
  task_id?: string;
  artifact_id?: string;
  message_id?: string;
  file_path?: string;
  line_number?: number;
  repository?: string;
  ref?: string;
  pull_request_id?: string;
  decision_id?: string;
  /** The thread's subject when the kind names one: a decision's question. */
  title?: string;
  last_activity_at: number;
  last_read_at: number;
  updated_at: number;
  unread: number;
  unread_capped?: boolean;
  last_reply?: ThreadLastReply | null;
};

export type CommentWithUser = ConversationComment & {
  user: {
    _id?: Id<"users">;
    name?: string;
    github_username?: string;
    github_avatar_url?: string;
  };
};

/** A page discussion's comment as shipped to participants: everything the
 *  public page shows, minus the commenter's email. */
export type PageComment = Omit<Doc<"artifact_comments">, "author_email">;

/** The slice of an artifact a Threads card needs. Never the whole row: it
 *  carries owner_key, edit_key and password_hash, which are secrets. */
export type PageThreadEntity = {
  _id: string;
  slug: string;
  title: string;
  kind?: string;
  user_id: string;
  updated_at: number;
  comments: PageComment[];
};

export type ListMinePayload = {
  chat: {
    roots: Doc<"chat_messages">[];
    threads: ThreadSummary[];
    authors: Awaited<ReturnType<typeof authorsFor>>;
  };
  comments: CommentWithUser[];
  tasks: Array<Doc<"tasks"> & { comments: Doc<"task_comments">[] }>;
  pages: PageThreadEntity[];
  /** Code comment threads (review_comments), each thread's newest rows. The
   *  web lands them in its codeComments collection, the one the commit and
   *  pull request pages read. */
  codeComments: Doc<"review_comments">[];
};
