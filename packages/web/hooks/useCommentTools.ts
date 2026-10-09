import { createContext, useContext } from "react";
import { useInboxStore } from "../store/inboxStore";

/** Answers the viewer's "Comments" preference (Settings, Profile) for
 *  everything below it. The homepage hero sets it off so a message draws the
 *  same toolbar for every visitor. */
export const CommentToolsOverride = createContext<boolean | undefined>(undefined);

/** Whether to offer the tools that START a comment on a message. Reading and
 *  replying to existing comments never depends on it. */
export function useCommentTools(): boolean {
  const override = useContext(CommentToolsOverride);
  const pref = useInboxStore((s) => s.clientState.ui?.comments_enabled ?? false);
  return override ?? pref;
}
