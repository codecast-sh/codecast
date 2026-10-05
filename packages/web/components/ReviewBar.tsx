// The batch tray rendered INSIDE the composer block (above the textarea, like the
// queued-message and pasted-image strips) while there are pending inline quotes /
// comments or answers to an org proposal's cards (org-staffing.md S39). It
// previews what's ATTACHED to your next message: sending (Enter / the send
// button) carries these automatically, even with nothing typed: the quotes as
// text, the answers applied and written in plain words. Each row is removable
// with an ✕; "Edit in input" optionally materializes the quotes as editable
// text in the composer (answers stay); "Clear" discards everything.

import React, { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { X, Trash2, PencilLine } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useReviewComposer } from "./reviewContext";
import { cancelReview } from "../lib/reviewActions";
import { andList, ORG_REPLY_WORDS, type OrgReplyVerdict } from "@codecast/shared/contracts/orgProposal";
import { isProposalAnswer, sortPendingComments, type PendingComment, type PendingProposalAnswer } from "../lib/quoteFormat";
import { PageFavicon } from "./PublishedPageEmbed";
import "./ReviewNavigation.css";

import { useWatchEffect } from "../hooks/useWatchEffect";

type Answer = PendingComment & { proposal: PendingProposalAnswer };

/** "3 answers and 2 quotes", "3 answers", "2 quotes": what the next message carries. */
export function batchHeadWords(comments: readonly PendingComment[]): string {
  const answers = comments.filter(isProposalAnswer).length;
  const quotes = comments.length - answers;
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return andList([...(answers ? [count(answers, "answer")] : []), ...(quotes ? [count(quotes, "quote")] : [])]);
}

/** One tray row as the person reads it: the verdict word, who it is about, and the words. */
export type BatchRow = {
  /** The items the row stands for; ✕ withdraws them all. */
  items: PendingComment[];
  verdict?: OrgReplyVerdict;
  /** "Approve 1, 3 and 4", "Reject 2", "On all of it". */
  label?: string;
  /** The card's sentence, in quiet ink. */
  sentence?: string;
  /** The person's words. */
  body?: string;
};

/** The ordinals the person sees, or a count when the list does not number its cards. */
const whichCards = (answers: Answer[]): string => {
  const ordinals = answers.map((a) => a.proposal.ordinal).filter((n): n is number => n !== undefined);
  if (ordinals.length === answers.length) return andList([...ordinals].sort((a, b) => a - b).map(String));
  return `${answers.length} change${answers.length === 1 ? "" : "s"}`;
};

/** A proposal's answers as rows: bare approvals fold into one, every other answer is its own. */
export function answerRows(answers: Answer[]): BatchRow[] {
  const folded = answers.filter((a) => a.proposal.verdict === "approve" && !a.body.trim() && a.proposal.seqs.length);
  const rows: BatchRow[] = folded.length ? [{ items: folded, verdict: "approve", label: `${ORG_REPLY_WORDS.approve.act} ${whichCards(folded)}` }] : [];
  for (const a of answers) {
    if (folded.includes(a)) continue;
    const v = a.proposal.verdict;
    const whole = !a.proposal.seqs.length;
    const word = v === "note" ? "On" : ORG_REPLY_WORDS[v].act;
    const label = whole ? "On all of it" : a.proposal.ordinal !== undefined ? `${word} ${a.proposal.ordinal}` : word;
    rows.push({ items: [a], verdict: v, label, ...(whole ? {} : { sentence: a.quote }), ...(a.body.trim() ? { body: a.body } : {}) });
  }
  return rows;
}

/**
 * The rows of a batch, answers first grouped by proposal, then the quotes in
 * reading order. The composer's tray and a reply box with no composer
 * (ProposalReplyBox) draw the same rows. `onJump` scrolls to a row's source
 * where the host can; an answer carries no message to jump to unless the
 * host anchored it, so its row does nothing.
 */
export function PendingBatchRows({ batchKey, onJump }: { batchKey: string; onJump?: (comment: PendingComment) => void }) {
  const comments = useInboxStore(useShallow((s) => s.reviewComments[batchKey] ?? []));
  const answers = comments.filter(isProposalAnswer);
  const quotes = sortPendingComments(comments.filter((c) => !isProposalAnswer(c)));
  const byProposal = new Map<string, Answer[]>();
  for (const a of answers) (byProposal.get(a.proposal.id) ?? byProposal.set(a.proposal.id, []).get(a.proposal.id)!).push(a);
  const remove = (items: PendingComment[]) => { const s = useInboxStore.getState(); for (const c of items) s.removeReviewComment(batchKey, c.id); };
  return (
    <>
      {[...byProposal.values()].map((group) => (
        <React.Fragment key={group[0].proposal.id}>
          <div className="cc-review-tray-group" data-review-proposal={group[0].proposal.short_id}>{group[0].proposal.title || group[0].proposal.short_id}</div>
          {answerRows(group).map((row) => {
            const jump = onJump && row.items.length === 1 && row.items[0].messageId ? () => onJump(row.items[0]) : undefined;
            return (
              <div key={row.items.map((c) => c.id).join("+")} className="cc-review-tray-item" data-review-answer={row.verdict}>
                <button type="button" className="cc-review-tray-item-main cc-review-tray-jump" title={jump ? "Jump to this change" : undefined} disabled={!jump} onClick={jump}>
                  <span className="cc-review-tray-verdict" data-verdict={row.verdict}>{row.label}</span>
                  {row.sentence ? <span className="cc-review-tray-quote cc-review-tray-sentence">{row.sentence}</span> : null}
                  {row.body ? <span className="cc-review-tray-note block">{row.body}</span> : null}
                </button>
                <button type="button" className="cc-review-tray-x" title="Withdraw from message" aria-label="Withdraw this answer" onClick={() => remove(row.items)}>
                  <X size={13} />
                </button>
              </div>
            );
          })}
        </React.Fragment>
      ))}
      {quotes.map((c) => (
        <div key={c.id} className="cc-review-tray-item">
          <button
            type="button"
            className="cc-review-tray-item-main cc-review-tray-jump"
            title={c.image ? "Jump to the message with this image" : c.page ? "Jump to the message with this page" : "Jump to quoted passage"}
            disabled={!onJump}
            onClick={() => onJump?.(c)}
          >
            <span className="cc-review-tray-quote">
              {c.image
                ? (
                  <span className="cc-review-tray-thumb">
                    <img src={c.image.src} alt="" draggable={false} />
                    {c.image.point && (
                      <span className="cc-review-tray-pin" style={{ left: `${c.image.point.x * 100}%`, top: `${c.image.point.y * 100}%` }} />
                    )}
                  </span>
                )
                : c.page
                  ? <PageFavicon className="mr-1.5 h-3.5 w-3.5 align-[-2px]" />
                  : <span className="cc-comment-quote-mark">❝</span>}
              {(c.quote || "").replace(/\s+/g, " ").trim().slice(0, 140)}
            </span>
            {c.body ? <span className="cc-review-tray-note block">{c.body}</span> : null}
          </button>
          <button
            type="button"
            className="cc-review-tray-x"
            title="Remove from message"
            aria-label="Remove this quote"
            onClick={() => remove([c])}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </>
  );
}

export function ReviewBar({ conversationId }: { conversationId: string }) {
  const composer = useReviewComposer();
  const comments = useInboxStore(useShallow((s) => s.reviewComments[conversationId] ?? []));
  const count = comments.length;
  const hasQuotes = comments.some((c) => !isProposalAnswer(c));

  // Clear discards the whole batch, so it arms on first click ("Discard N?") and
  // only fires on the second; the armed state disarms itself after a beat.
  const [confirmClear, setConfirmClear] = useState(false);
  useWatchEffect(() => {
    if (!confirmClear) return;
    const t = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(t);
  }, [confirmClear]);

  if (!count) return null;

  return (
    <div className="cc-review-tray">
        <div className="cc-review-tray-head">
          <span className="cc-review-tray-title">
            <span className="cc-review-dot" />
            {batchHeadWords(comments)}
            {/* Say where they go: the batch rides along on the next send, even
                with nothing typed. Without this the tray states a count and
                leaves the user hunting for an "attach" step that doesn't exist. */}
            <span className="cc-review-tray-dest">on your next message</span>
          </span>
          <div className="cc-review-tray-actions">
            <button
              type="button"
              className={`cc-comment-btn cc-comment-btn-danger ${confirmClear ? "cc-comment-btn-confirm" : ""}`}
              onClick={() => {
                if (confirmClear) cancelReview(conversationId);
                else setConfirmClear(true);
              }}
            >
              <Trash2 size={11} />
              {confirmClear ? `Discard ${count}?` : "Clear"}
            </button>
            {/* Only quotes can become text; an answer turned into words would send and apply nothing. */}
            {hasQuotes ? (
              <button type="button" className="cc-comment-btn cc-comment-btn-primary" onClick={() => composer?.submit()}>
                <PencilLine size={11} />
                Edit in input
              </button>
            ) : null}
          </div>
        </div>
        <div className="cc-review-tray-list">
          <PendingBatchRows batchKey={conversationId} onJump={composer?.jumpToComment} />
      </div>
    </div>
  );
}
