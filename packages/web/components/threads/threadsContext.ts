import { createContext, useContext } from "react";
import type { ChatMember, HandleSets } from "../../lib/chatViews";
import type { ThreadInboxCard } from "../../hooks/useThreadsSync";
import type { ThreadCardModel } from "../../lib/threadCards";
import type { Comment } from "../../lib/commentThread";

// What every card on the Threads page shares, assembled ONCE by the page: the
// clock, presence, the chat roster, and the chat roots ready to render. A
// per-card reader for any of these would recompute a full-collection
// signature per push per card (see useThreadInboxCards). Lives apart from the
// components so the context object is not a Fast Refresh boundary.

export type ThreadsPageContextValue = {
  /** The page's shared coarse clock. */
  now: number;
  /** The reader is actually here: tab active, window focused. Reads follow it. */
  present: boolean;
  /** The active workspace team, if any. */
  teamId?: string;
  viewerId: string;
  members: ChatMember[];
  handles: HandleSets;
  nameOf: (userId: string) => string;
  /** Chat thread roots, rendered, by root id. */
  chatCards: Map<string, ThreadInboxCard>;
  /** Comment threads by the row's root_key, assembled once (useCommentThreadMap). */
  commentThreads: Map<string, Comment[]>;
  /** Expand or collapse a card (one open at a time). */
  toggle: (card: ThreadCardModel) => void;
};

export const ThreadsPageCtx = createContext<ThreadsPageContextValue | null>(null);

export function useThreadsPage(): ThreadsPageContextValue {
  const v = useContext(ThreadsPageCtx);
  if (!v) throw new Error("useThreadsPage: no ThreadsPageCtx above this component");
  return v;
}
