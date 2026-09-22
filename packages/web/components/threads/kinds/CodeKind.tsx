import { useCallback } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { CheckCircle2, FileCode2, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { parseCodeThreadRootKey } from "@codecast/shared/comments";
import { useInboxStore, type ThreadInboxRow } from "../../../store/inboxStore";
import { useCodeComments } from "../../../hooks/useSyncCodeComments";
import { useLineComments } from "../../../hooks/useLineComments";
import { serverCommentId, threadResolved, threadSide, type CodeCommentRow } from "../../../lib/prView";
import { replyPreview, type CardPreview, type ThreadCardModel } from "../../../lib/threadCards";
import { PRLineThread } from "../../pr/PRThread";
import { useTailPin } from "../cardWindow";

// The code kind: one thread of comments on code — a line of a commit's diff,
// a line of a pull request, or the commit or pull request itself. The row
// names the repository and the ref and previews the newest reply (or the
// root comment while it has none); open, the file and line, then the same
// thread the commit page draws under the line, composer and resolve control
// included.

function rowOf(card: ThreadCardModel): ThreadInboxRow {
  return card.source as ThreadInboxRow;
}

/** Where the thread hangs, from the row's typed refs or, failing those, its key. */
function anchorOf(row: ThreadInboxRow): { repository: string; ref: string; filePath?: string; lineNumber?: number } {
  const parsed = parseCodeThreadRootKey(row.root_key);
  return {
    repository: row.repository ?? parsed.repository,
    ref: row.ref ?? parsed.ref,
    filePath: row.file_path ?? parsed.filePath,
    lineNumber: row.line_number ?? parsed.lineNumber,
  };
}

/** The pull request's number, when the row names one the store has seen. */
function usePrNumber(prId: string | undefined): number | undefined {
  return useInboxStore((s) => (prId ? (s.pullRequests as Record<string, any>)[prId]?.number : undefined));
}

/** The thread's rows, oldest first, from the store the commit page reads. */
function useThreadRows(row: ThreadInboxRow): CodeCommentRow[] {
  const { repository, ref, filePath, lineNumber } = anchorOf(row);
  return useCodeComments(
    useCallback(
      (c: CodeCommentRow) =>
        c.repository === repository &&
        c.ref === ref &&
        (c.file_path ?? undefined) === filePath &&
        (c.line_number ?? undefined) === lineNumber,
      [repository, ref, filePath, lineNumber],
    ),
  );
}

export function CodeLabel({ card }: { card: ThreadCardModel }) {
  const row = rowOf(card);
  const { repository, ref } = anchorOf(row);
  const prNumber = usePrNumber(row.pull_request_id);
  return (
    <>
      {prNumber ? (
        <GitPullRequest className="w-3 h-3 text-sol-green" />
      ) : (
        <GitCommitHorizontal className="w-3 h-3 text-sol-violet" />
      )}
      <span className="font-mono">
        {repository}
        {prNumber ? `#${prNumber}` : `@${ref.slice(0, 7)}`}
      </span>
    </>
  );
}

export function useCodePreview(card: ThreadCardModel): CardPreview | null {
  const row = rowOf(card);
  const comments = useThreadRows(row);
  const reply = replyPreview(row.last_reply);
  if (reply) {
    if (reply.whoKind === "user" && !reply.who) reply.who = "Teammate";
    return reply;
  }
  const root = comments[0];
  if (!root) return null;
  const agent = (root as any).author_kind === "agent";
  return {
    who: agent ? "Agent" : (root as any).author_name ?? (root as any).author_github_username ?? "Teammate",
    whoKind: agent ? "agent" : "user",
    text: String((root as any).content ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

function AnchorLine({ filePath, lineNumber, prNumber }: { filePath?: string; lineNumber?: number; prNumber?: number }) {
  if (filePath) {
    return (
      <div className="th-card-anchor">
        <FileCode2 className="w-3 h-3 shrink-0" />
        <span className="th-card-anchor-text">{filePath}{lineNumber ? `:${lineNumber}` : ""}</span>
      </div>
    );
  }
  return (
    <div className="th-card-anchor">
      {prNumber ? <GitPullRequest className="w-3 h-3 shrink-0" /> : <GitCommitHorizontal className="w-3 h-3 shrink-0" />}
      <span className="th-card-anchor-text">{prNumber ? "The pull request" : "The commit"}</span>
    </div>
  );
}

export function CodeMeta({ card }: { card: ThreadCardModel }) {
  const row = rowOf(card);
  const { filePath, lineNumber } = anchorOf(row);
  const prNumber = usePrNumber(row.pull_request_id);
  const comments = useThreadRows(row);
  const resolved = comments.length > 0 && threadResolved(comments);
  return (
    <div className="th-card-anchorrow">
      <AnchorLine filePath={filePath} lineNumber={lineNumber} prNumber={prNumber} />
      {resolved && (
        <span className="th-card-chip th-card-chip-resolved">
          <CheckCircle2 className="w-3 h-3" /> Resolved
        </span>
      )}
    </div>
  );
}

export function CodeExpanded({ card, seen }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const row = rowOf(card);
  const anchor = anchorOf(row);
  const comments = useThreadRows(row);
  const lineComments = useLineComments({ repository: anchor.repository, ref: anchor.ref, comments });

  // The read law, as the comment kind keeps it: the row is open and the
  // reader is here, and never while the store holds nothing for an unread
  // thread.
  useWatchEffect(() => {
    if (!seen) return;
    if (row.unread > 0 && comments.length === 0) return;
    if (row.last_read_at >= row.last_activity_at && row.unread === 0) return;
    useInboxStore.getState().markThreadRead("code", row.root_key);
  }, [seen, row.root_key, row.last_activity_at, row.last_read_at, row.unread, comments.length]);

  const pinRef = useTailPin(comments.length ? `${comments[comments.length - 1]._id}|${comments.length}` : "");

  return (
    <div ref={pinRef} className="th-card-open th-card-open-comments">
      <PRLineThread
        repository={anchor.repository}
        threadKey={row.root_key}
        comments={comments}
        authed={lineComments.authed}
        lineNumber={anchor.lineNumber}
        onReply={(content) =>
          lineComments.post({
            ...(anchor.filePath ? { file_path: anchor.filePath, line_number: anchor.lineNumber } : {}),
            ...(comments.length && anchor.filePath ? { side: threadSide(comments) } : {}),
            content,
            parent_id: serverCommentId(comments[0]?._id),
            ...(row.pull_request_id ? { pull_request_id: row.pull_request_id } : {}),
          })
        }
        onResolve={(resolved) => lineComments.setThreadResolved(comments, resolved)}
        onClose={() => {}}
      />
    </div>
  );
}
