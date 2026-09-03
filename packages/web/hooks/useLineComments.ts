// Writing and grouping comments on lines of code.
//
// A comment on a line is the same object everywhere it is written: on a pull
// request, on a commit, or on a file in the source browser. Only the anchor
// changes (the ref it points at, and whether it is mirrored to GitHub), so the
// grouping, the optimistic write and the resolve control live here once.
import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useCurrentUser } from "./useCurrentUser";
import { useInboxStore } from "../store/inboxStore";
import { groupCommentsByFileLine, type CodeCommentRow } from "../lib/prView";

const api = _api as any;

export type ComposingLine = { file: string; line: number };

export type LineComments = {
  /** file to line to the thread on that line, with the line a composer is open
   *  on carrying an empty thread so the viewer draws a row for it. */
  threadsByFile: Map<string, Map<number, CodeCommentRow[]>>;
  composing: ComposingLine | null;
  openComposer: (file: string, line: number) => void;
  closeComposer: () => void;
  post: (fields: Record<string, unknown>) => Promise<void>;
  setThreadResolved: (thread: CodeCommentRow[], resolved: boolean) => void;
  authed: boolean;
};

export function useLineComments({
  repository,
  ref,
  comments,
  mirror,
  conversationId,
}: {
  repository: string;
  /** The commit sha or branch tip the comment is anchored to. */
  ref: string | undefined;
  comments: CodeCommentRow[];
  /** Mirror to GitHub. True only when the file is part of an open pull request. */
  mirror?: boolean;
  /** The session the reader came from, so the comment knows where it was written. */
  conversationId?: string;
}): LineComments {
  const { user, isAuthenticated } = useCurrentUser();
  const createComment = useMutation(api.codeComments.create);
  const resolveComment = useMutation(api.codeComments.resolve);
  const unresolveComment = useMutation(api.codeComments.unresolve);
  const [composing, setComposing] = useState<ComposingLine | null>(null);

  const threadsByFile = useMemo(() => {
    const grouped = groupCommentsByFileLine(comments);
    if (composing) {
      const byLine = new Map(grouped.get(composing.file) ?? []);
      if (!byLine.has(composing.line)) byLine.set(composing.line, []);
      grouped.set(composing.file, byLine);
    }
    return grouped;
  }, [comments, composing]);

  const post = useCallback(
    async (fields: Record<string, unknown>) => {
      const clientId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Render it now; the server row carrying this client_id supersedes the
      // stub when the feed echoes it back (the collection's altKey).
      useInboxStore.getState().syncRecord("codeComments", clientId, {
        _id: clientId,
        client_id: clientId,
        repository,
        ref,
        content: fields.content,
        resolved: false,
        created_at: Date.now(),
        author_user_id: user?._id,
        author_kind: "user",
        ...fields,
      });
      await createComment({
        repository,
        ...(ref ? { ref } : {}),
        ...(conversationId ? { conversation_ref: conversationId } : {}),
        client_id: clientId,
        mirror: mirror ?? false,
        ...fields,
      });
    },
    [createComment, repository, ref, conversationId, mirror, user?._id],
  );

  const setThreadResolved = useCallback(
    (thread: CodeCommentRow[], resolved: boolean) => {
      for (const comment of thread) {
        // An optimistic stub has no server row to resolve yet.
        if (comment._id.startsWith("cc-")) continue;
        void (resolved ? resolveComment : unresolveComment)({ comment_id: comment._id });
      }
    },
    [resolveComment, unresolveComment],
  );

  return {
    threadsByFile,
    composing,
    openComposer: useCallback((file: string, line: number) => setComposing({ file, line }), []),
    closeComposer: useCallback(() => setComposing(null), []),
    post,
    setThreadResolved,
    authed: isAuthenticated,
  };
}

/** The session a code page should attribute its comments to: the one named in
 *  the URL, else the one the reader has open beside it. */
export function useAttributedSession(fromUrl: string | null | undefined): string | undefined {
  const fromRail = useInboxStore((s) => s.currentSessionId ?? s.sidePanelSessionId ?? null);
  return fromUrl || fromRail || undefined;
}
