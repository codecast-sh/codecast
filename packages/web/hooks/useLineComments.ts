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
import {
  groupCommentsByFileLine,
  newCommentClientId,
  serverCommentId,
  type CodeCommentRow,
} from "../lib/prView";
import { diffLineKey, type DiffLineAnchor } from "../lib/patchParser";

const api = _api as any;

export type ComposingLine = { file: string; anchor: DiffLineAnchor };

export type LineComments = {
  /** file to anchor key (`diffLineKey`: side and line) to the thread there, with
   *  the anchor a composer is open on carrying an empty thread so the viewer
   *  draws a row for it. */
  threadsByFile: Map<string, Map<string, CodeCommentRow[]>>;
  composing: ComposingLine | null;
  openComposer: (file: string, anchor: DiffLineAnchor) => void;
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
  /**
   * Suppress the GitHub mirror. Leave it unset unless the surface has a reason
   * the server cannot know: `codeComments.create` mirrors by default and
   * already refuses unless an OPEN pull request touches the file, so a client
   * that decides for itself is re-implementing a rule it does not own.
   */
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
      const key = diffLineKey(composing.anchor);
      const byAnchor = new Map(grouped.get(composing.file) ?? []);
      if (!byAnchor.has(key)) byAnchor.set(key, []);
      grouped.set(composing.file, byAnchor);
    }
    return grouped;
  }, [comments, composing]);

  const post = useCallback(
    async (fields: Record<string, unknown>) => {
      const clientId = newCommentClientId();
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
        // Omitted, not defaulted: the server treats "absent" as yes and only
        // an explicit false as no. Sending `false` here is what silently kept
        // every comment written outside a pull request off GitHub.
        ...(mirror === undefined ? {} : { mirror }),
        ...fields,
      });
    },
    [createComment, repository, ref, conversationId, mirror, user?._id],
  );

  const setThreadResolved = useCallback(
    (thread: CodeCommentRow[], resolved: boolean) => {
      for (const comment of thread) {
        // An optimistic stub has no server row to resolve yet.
        const id = serverCommentId(comment._id);
        if (!id) continue;
        void (resolved ? resolveComment : unresolveComment)({ comment_id: id });
      }
    },
    [resolveComment, unresolveComment],
  );

  return {
    threadsByFile,
    composing,
    openComposer: useCallback((file: string, anchor: DiffLineAnchor) => setComposing({ file, anchor }), []),
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
