import { useCallback, useEffect } from "react";
import { CheckCircle2, FileCode2, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { parseCodeThreadRootKey } from "@codecast/shared/comments";
import { useInboxStore, type ThreadInboxRow } from "../../../store/inboxStore";
import { useCodeComments } from "../../../hooks/useSyncCodeComments";
import { useLineComments } from "../../../hooks/useLineComments";
import { serverCommentId, threadResolved, threadSide, type CodeCommentRow } from "../../../lib/prView";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { PRCommentCard, PRLineThread } from "../../pr/PRThread";
import { useTailPin } from "../cardWindow";
import { useThreadsPage } from "../threadsContext";

// The code kind: one thread of comments on code — a line of a commit's diff,
// a line of a pull request, or the commit or pull request itself. The
// collapsed card names the repository and the ref, then the file and line,
// and shows the root comment; expanded, the same thread the commit page
// draws under the line, composer and resolve control included.

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

export function CodeRoot({ card, expanded }: { card: ThreadCardModel; expanded: boolean }) {
  const row = rowOf(card);
  const { filePath, lineNumber } = anchorOf(row);
  const prNumber = usePrNumber(row.pull_request_id);
  const comments = useThreadRows(row);
  const { toggle } = useThreadsPage();
  const root = comments[0];
  const resolved = comments.length > 0 && threadResolved(comments);
  const replies = Math.max(0, comments.length - 1);
  const lastReply = row.last_reply;
  const open = useCallback(() => toggle(card), [toggle, card]);
  return (
    <>
      <div className="th-card-anchorrow">
        <AnchorLine filePath={filePath} lineNumber={lineNumber} prNumber={prNumber} />
        {resolved && (
          <span className="th-card-chip th-card-chip-resolved">
            <CheckCircle2 className="w-3 h-3" /> Resolved
          </span>
        )}
      </div>
      {!expanded && (
        root ? (
          <div className="th-card-root th-card-comment">
            <PRCommentCard comment={root} />
          </div>
        ) : (
          <div className="th-card-root th-card-ghost" aria-hidden="true">
            <div className="ch-skel-line ch-skel-head" />
            <div className="ch-skel-line" style={{ width: "62%" }} />
          </div>
        )
      )}
      {!expanded && (
        <button type="button" className="th-card-summary" onClick={open}>
          <span className="th-card-count">{summaryCount(replies, "reply", "replies")}</span>
          {lastReply && replies > 0 && (
            <span className="th-card-preview">
              <span className="th-card-preview-name">{lastReply.author_name ?? (lastReply.author_kind === "agent" ? "Agent" : "Teammate")}:</span>{" "}
              {lastReply.preview}
            </span>
          )}
        </button>
      )}
    </>
  );
}

export function CodeExpanded({ card, seen }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const row = rowOf(card);
  const anchor = anchorOf(row);
  const comments = useThreadRows(row);
  const lineComments = useLineComments({ repository: anchor.repository, ref: anchor.ref, comments });

  // The read law, as the comment kind keeps it: presence plus the newest
  // content actually in view, and never while the store holds nothing for an
  // unread thread.
  useEffect(() => {
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
