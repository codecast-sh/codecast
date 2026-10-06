// The batch tray rendered INSIDE the composer block (above the textarea, like the
// queued-message and pasted-image strips) while there are pending inline quotes /
// comments or answers to an org proposal's cards (org-staffing.md S39). It
// previews what the next send carries: the quotes as text, the answers applied
// and written in plain words. The head is one sentence from batchSendWords (the
// one home for the counting); each row is removable with an x; "Edit in input"
// optionally materializes the quotes as editable text in the composer (answers
// stay); "Clear" discards everything.

import React, { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { X, Trash2, PencilLine } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useReviewComposer } from "./reviewContext";
import { batchSendWords, cancelReview } from "../lib/reviewActions";
import { andList, ORG_REPLY_WORDS, type OrgReplyVerdict } from "@codecast/shared/contracts/orgProposal";
import { isProposalAnswer, sortPendingComments, type PendingComment, type PendingProposalAnswer } from "../lib/quoteFormat";
import { PageFavicon } from "./PublishedPageEmbed";
import "./ReviewNavigation.css";

import { useWatchEffect } from "../hooks/useWatchEffect";

type Answer = PendingComment & { proposal: PendingProposalAnswer };

/** One tray row as the person reads it: the verdict word, who it is about, and the words. */
export type BatchRow = {
  /** The items the row stands for; the x withdraws them all. */
  items: PendingComment[];
  verdict?: OrgReplyVerdict;
  /** "Approve", "Reject", "On", "On all of it". */
  label?: string;
  /** The subjects the row is about, in quiet ink. */
  sentence?: string;
  /** The person's words. */
  body?: string;
};

/** What names an answer in the tray: the card's or the group's title, else its sentence. */
const subjectOf = (a: Answer) => a.proposal.subject || a.quote;

/** One, two or three subjects in full; past that the first three and a count. */
function subjectsLine(answers: Answer[]): string {
  const subjects = answers.map(subjectOf);
  if (subjects.length <= 3) return andList(subjects);
  return `${subjects.slice(0, 3).join(", ")} and ${subjects.length - 3} more`;
}

/** A proposal's answers as rows: bare approvals fold into one row named by
 *  their subjects; every reject and note is its own row with its subject and
 *  words. A note on the whole proposal (a legacy item with no seqs) reads
 *  "On all of it"; no surface creates them any more. */
export function answerRows(answers: Answer[]): BatchRow[] {
  const folded = answers.filter((a) => a.proposal.verdict === "approve" && !a.body.trim() && a.proposal.seqs.length);
  const rows: BatchRow[] = folded.length ? [{ items: folded, verdict: "approve", label: ORG_REPLY_WORDS.approve.act, sentence: subjectsLine(folded) }] : [];
  for (const a of answers) {
    if (folded.includes(a)) continue;
    const v = a.proposal.verdict;
    const whole = !a.proposal.seqs.length;
    const label = whole ? "On all of it" : v === "note" ? "On" : ORG_REPLY_WORDS[v].act;
    rows.push({ items: [a], verdict: v, label, ...(whole ? {} : { sentence: subjectOf(a) }), ...(a.body.trim() ? { body: a.body } : {}) });
  }
  return rows;
}

const FLASH_MS = 1200;

/** Scroll the thread to the entry a row answers (its card for a note on the
 *  whole) and flash it once. The card is the one scroll target every surface
 *  uses (`data-proposal-card`); the entry is its `data-subject`. */
function jumpToAnswer(a: Answer): void {
  const card = `[data-proposal-card="${a.proposal.short_id}"]`;
  const el = document.querySelector<HTMLElement>(a.proposal.card ? `${card} [data-subject="${CSS.escape(a.proposal.card)}"]` : card);
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.setAttribute("data-flash", "");
  setTimeout(() => el.removeAttribute("data-flash"), FLASH_MS);
}

/**
 * The rows of a batch, answers first grouped by proposal, then the quotes in
 * reading order. `onJump` scrolls to a quote's source where the host can; an
 * answer's row scrolls to its entry on the card itself. `proposalId` narrows
 * the rows to one proposal's answers for a surface that stands under one
 * proposal and cannot send the quotes.
 */
export function PendingBatchRows({ batchKey, proposalId, onJump }: { batchKey: string; proposalId?: string; onJump?: (comment: PendingComment) => void }) {
  const comments = useInboxStore(useShallow((s) => s.reviewComments[batchKey] ?? []));
  const answers = comments.filter(isProposalAnswer).filter((a) => !proposalId || a.proposal.id === proposalId);
  const quotes = proposalId ? [] : sortPendingComments(comments.filter((c) => !isProposalAnswer(c)));
  const byProposal = new Map<string, Answer[]>();
  for (const a of answers) (byProposal.get(a.proposal.id) ?? byProposal.set(a.proposal.id, []).get(a.proposal.id)!).push(a);
  const remove = (items: PendingComment[]) => { const s = useInboxStore.getState(); for (const c of items) s.removeReviewComment(batchKey, c.id); };
  return (
    <>
      {[...byProposal.values()].map((group) => (
        <React.Fragment key={group[0].proposal.id}>
          <div className="cc-review-tray-group" data-review-proposal={group[0].proposal.short_id}>{group[0].proposal.title || group[0].proposal.short_id}</div>
          {answerRows(group).map((row) => (
            <div key={row.items.map((c) => c.id).join("+")} className="cc-review-tray-item" data-review-answer={row.verdict} data-review-count={row.items.length}>
              <button type="button" className="cc-review-tray-item-main cc-review-tray-jump" title="Show this on the card" onClick={() => jumpToAnswer(row.items[0] as Answer)}>
                <span className="cc-review-tray-verdict" data-verdict={row.verdict}>{row.label}</span>
                {row.sentence ? <span className="cc-review-tray-quote cc-review-tray-sentence">{row.sentence}</span> : null}
                {row.body ? <span className="cc-review-tray-note block">{row.body}</span> : null}
              </button>
              <button type="button" className="cc-review-tray-x" title="Undo" aria-label="Undo this answer" onClick={() => remove(row.items)}>
                <X size={13} />
              </button>
            </div>
          ))}
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
  // Answers are the reply being built, so the list grows to show them (the
  // reply box's cap); a quote-only batch keeps the composer's short tray.
  const hasAnswers = comments.some(isProposalAnswer);
  const words = batchSendWords(comments);

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
    <div className="cc-review-tray" data-applies={words.applies > 0 ? "" : undefined}>
        <div className="cc-review-tray-head">
          <span className="cc-review-tray-title" data-review-head={words.head ?? undefined}>
            <span className="cc-review-dot" />
            {words.head}
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
        <div className={hasAnswers ? "cc-review-tray-list cc-review-tray-list-grow canvas-scroll" : "cc-review-tray-list"}>
          <PendingBatchRows batchKey={conversationId} onJump={composer?.jumpToComment} />
      </div>
    </div>
  );
}
