import { useCallback, useMemo, useState } from "react";
import { CornerDownRight, ExternalLink } from "lucide-react";
import { useInboxStore, useTrackedStore, type ThreadInboxRow } from "../../../store/inboxStore";
import { newPageCommentClientId } from "../../../store/chatSlice";
import type { PageCommentRow, PageThreadRow } from "../../../store/threadTypes";
import { relTimeShort } from "../../../lib/utils";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { CommentAvatar } from "../../comments/CommentAvatar";
import { useTailPin } from "../cardWindow";
import { useThreadsPage } from "../threadsContext";

import { useWatchEffect } from "../../../hooks/useWatchEffect";
// The page kind: the comment discussion on a published page (cast publish).
// The collapsed card is the page title and the newest comment; expanded, the
// whole discussion oldest first with replies indented one level, and a reply
// box that posts through the store's addPageComment (optimistic stub, server
// echo supersedes by client_id). "Open" goes to the published page itself.

function rowOf(card: ThreadCardModel): ThreadInboxRow {
  return card.source as ThreadInboxRow;
}

/** The page row, woken only by what a card shows. */
function pageSig(p: PageThreadRow | undefined): string {
  if (!p) return "";
  const last = p.comments[p.comments.length - 1];
  return `${p.title}|${p.slug}|${p.comments.length}|${last?._id ?? ""}|${last?.text.length ?? 0}`;
}

function usePageRow(artifactId: string): PageThreadRow | undefined {
  const s = useTrackedStore([(s: any) => pageSig(s.pageThreads[artifactId])]);
  return (s as any).pageThreads[artifactId] as PageThreadRow | undefined;
}

export function PageLabel({ card }: { card: ThreadCardModel }) {
  const page = usePageRow(rowOf(card).root_key);
  return <>{page?.title ?? "Published page"}</>;
}

export function PageRoot({ card, expanded }: { card: ThreadCardModel; expanded: boolean }) {
  const row = rowOf(card);
  const page = usePageRow(row.root_key);
  const { toggle } = useThreadsPage();
  const lastReply = row.last_reply;
  const count = page?.comments.length ?? 0;
  return (
    <>
      {!expanded && (
        <button type="button" className="th-card-summary" onClick={() => toggle(card)}>
          <span className="th-card-count">{summaryCount(count, "comment")}</span>
          {lastReply && (
            <span className="th-card-preview">
              <span className="th-card-preview-name">{lastReply.author_name ?? "A viewer"}:</span>{" "}
              {lastReply.preview}
            </span>
          )}
        </button>
      )}
    </>
  );
}

/** Roots in order, each followed by its replies — one level, like the source
 *  table (`parent_comment_id` is one deep). */
function threadOrder(comments: PageCommentRow[]): Array<{ c: PageCommentRow; reply: boolean }> {
  const roots = comments.filter((c) => !c.parent_comment_id);
  const byParent = new Map<string, PageCommentRow[]>();
  for (const c of comments) {
    if (!c.parent_comment_id) continue;
    const list = byParent.get(c.parent_comment_id) ?? [];
    list.push(c);
    byParent.set(c.parent_comment_id, list);
  }
  const out: Array<{ c: PageCommentRow; reply: boolean }> = [];
  for (const r of roots.sort((a, b) => a.created_at - b.created_at)) {
    out.push({ c: r, reply: false });
    for (const child of (byParent.get(r._id) ?? []).sort((a, b) => a.created_at - b.created_at)) {
      out.push({ c: child, reply: true });
    }
  }
  return out;
}

export function PageExpanded({ card, seen }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  const row = rowOf(card);
  const page = usePageRow(row.root_key);
  const { now } = useThreadsPage();
  const [text, setText] = useState("");

  const commentCount = page?.comments?.length ?? 0;

  // The read law: mark read only while the card's newest content has actually
  // been in the viewport (`seen`, the shell's tail sentinel), never on mount —
  // and never while the store holds nothing for an unread discussion: on a
  // cold cache the body renders empty and short, so the sentinel is trivially
  // in view with the newest comment never rendered. The count dep fires the
  // mark once the page thread syncs in.
  useWatchEffect(() => {
    if (!seen) return;
    if (row.unread > 0 && commentCount === 0) return;
    if (row.last_read_at >= row.last_activity_at && row.unread === 0) return;
    useInboxStore.getState().markThreadRead("page", row.root_key);
  }, [seen, row.root_key, row.last_activity_at, row.last_read_at, row.unread, commentCount]);

  const ordered = useMemo(() => threadOrder(page?.comments ?? []), [page?.comments]);

  // The comments list is the capped scroller (55vh); pinned to the tail so
  // the newest comment is what shows — the read sentinel below assumes it.
  const pinRef = useTailPin(ordered.length ? `${ordered[ordered.length - 1].c._id}|${ordered.length}` : "");

  const send = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    useInboxStore.getState().addPageComment({ artifactId: row.root_key, text: t, clientId: newPageCommentClientId() });
    setText("");
  }, [row.root_key, text]);

  return (
    <div className="th-card-open th-card-open-page">
      <div ref={pinRef} className="th-page-comments">
        {ordered.map(({ c, reply }) => (
          <div key={c._id} className={`th-page-comment ${reply ? "th-page-comment-reply" : ""}`}>
            <CommentAvatar name={c.author_name} image={c.author_avatar} size={20} />
            <div className="th-page-comment-body">
              <span className="th-page-comment-head">
                <span className="th-page-comment-name">{c.author_name}</span>
                <span className="th-page-comment-age">{relTimeShort(c.created_at, now)}</span>
                {c.status === "resolved" && <span className="th-page-comment-resolved">resolved</span>}
              </span>
              <span className="th-page-comment-text">{c.text}</span>
            </div>
          </div>
        ))}
        {ordered.length === 0 && <div className="th-card-note">No comments yet.</div>}
      </div>
      <div className="th-page-composer">
        <input
          type="text"
          className="th-question-input"
          placeholder="Reply on the page…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
        />
        <button type="button" className="th-question-send" onClick={send} disabled={!text.trim()} title="Reply">
          <CornerDownRight className="w-3.5 h-3.5" />
        </button>
        {page && (
          <a className="th-page-openlink" href={`/a/${page.slug}`} target="_blank" rel="noreferrer">
            <ExternalLink className="w-3 h-3" /> Open page
          </a>
        )}
      </div>
    </div>
  );
}
