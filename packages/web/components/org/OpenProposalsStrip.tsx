"use client";
// The open proposals, as ONE line above the Head of People's conversation
// (docs/architecture/org-staffing.md S41): how many wait, the changes they
// hold, the answers staged for the next send, and the proposal the address
// names as a breadcrumb with an x that clears it. The line opens the rows on
// click (one per proposal, oldest first, capped at 38% of the column with
// their own scroll) and they close after a pick; a pick scrolls the thread to
// that card. A proposal written on another thread has no card here, so its
// pick opens the card under the line instead, capped at half the column or
// 480px with its own scroll: the answers join this conversation's batch and
// the send tells that thread. Above the line, one line for a `?proposal=`
// the rows do not hold.
import { useMemo, useState } from "react";
import { ChevronRight, MessageSquareText, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { EntityObjectCard } from "../EntityObjectCard";
import { ReviewComposerContext, type ReviewComposer } from "../reviewContext";
import { RoleFace } from "./RoleFace";
import { stripLine, type StripRow } from "./orgScreenModel";

export type { StripRow };

/** A `?proposal=` the rows do not hold: where it is, or that it cannot be read. */
export type LinkLineState =
  | { kind: "foreign"; shortId: string; workspaceName: string; teamId: string | null }
  | { kind: "unreadable" | "loading"; shortId: string };

export type OpenProposalsStripProps = {
  rows: StripRow[];
  /** The `?proposal=` row: the breadcrumb, and aria-current among the rows. */
  current: string | null;
  /** The foreign row whose card is open under the line. */
  expanded: string | null;
  /** The conversation whose batch an expanded card's answers join; null draws it read only. */
  batchConversationId: string | null;
  linkLine: LinkLineState | null;
  onPick: (row: StripRow) => void;
  /** The card's Close. */
  onCollapse: () => void;
  /** The breadcrumb's x: the address forgets the proposal. */
  onClearCurrent: () => void;
  onSwitchWorkspace: (teamId: string | null) => void;
};

/** The open rows take at most this share of the column. */
export const STRIP_ROWS_SHARE = 0.38;
/** The expanded card takes at most this share of the column, and never more than the px. */
export const STRIP_CARD_SHARE = 0.5;
export const STRIP_CARD_MAX_PX = 480;
const BORDER = "color-mix(in srgb, var(--sol-border) 22%, transparent)";

/** The height of the column the strip sits in (its parent), live; null until
 *  laid out, when the caps fall back to viewport shares. */
function useColumnHeight(el: HTMLElement | null): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useWatchEffect(() => {
    const column = el?.parentElement;
    if (!column) return;
    const apply = (h: number) => setHeight(h > 0 ? h : null);
    apply(column.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => { const box = entries[0]?.contentRect; if (box) apply(box.height); });
    ro.observe(column);
    return () => ro.disconnect();
  }, [el]);
  return height;
}

export function OpenProposalsStrip({ rows, current, expanded, batchConversationId, linkLine, onPick, onCollapse, onClearCurrent, onSwitchWorkspace }: OpenProposalsStripProps) {
  const [listOpen, setListOpen] = useState(false);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const columnHeight = useColumnHeight(section);
  if (rows.length === 0 && !linkLine) return null;
  const line = stripLine(rows);
  const crumb = current ? rows.find((r) => r.proposal.short_id === current) ?? null : null;
  const card = expanded ? rows.find((r) => r.proposal.short_id === expanded) ?? null : null;
  // The rows when the person opened them; else the card a pick or a link
  // opened; else the line alone.
  const open = listOpen ? "rows" : card ? "card" : null;
  const rowsCap = columnHeight ? `${Math.round(columnHeight * STRIP_ROWS_SHARE)}px` : `${STRIP_ROWS_SHARE * 100}vh`;
  const cardCap = columnHeight ? `${Math.min(Math.round(columnHeight * STRIP_CARD_SHARE), STRIP_CARD_MAX_PX)}px` : `min(${STRIP_CARD_SHARE * 100}vh, ${STRIP_CARD_MAX_PX}px)`;
  const pick = (row: StripRow) => { setListOpen(false); onPick(row); };
  return (
    <section ref={setSection} data-org-strip={rows.length} data-org-strip-open={open ?? undefined} className="shrink-0 border-b flex flex-col min-h-0" style={{ background: "color-mix(in srgb, var(--sol-violet) 5%, var(--sol-bg))", borderColor: BORDER }}>
      {linkLine && <LinkLine line={linkLine} onSwitchWorkspace={onSwitchWorkspace} />}
      {rows.length > 0 && (
        <div className="shrink-0 h-9 pl-2 pr-3 flex items-center gap-1 min-w-0" data-org-strip-head>
          <button
            type="button"
            onClick={() => setListOpen(!listOpen)}
            aria-expanded={listOpen}
            className="h-7 min-w-0 shrink-0 flex items-center gap-1.5 rounded-md px-1.5 text-[13px] hover:bg-sol-bg-highlight/50 focus-visible:outline-none focus-visible:ring-2"
            style={{ color: "var(--sol-text)", ["--tw-ring-color" as string]: "var(--sol-violet)" }}
            data-org-strip-toggle
          >
            <ChevronRight className={cn("w-3.5 h-3.5 shrink-0 transition-transform", listOpen && "rotate-90")} style={{ color: "var(--sol-text-dim)" }} />
            <span className="font-semibold whitespace-nowrap">{line.wait}</span>
            {line.changes && <><Dot /><span className="whitespace-nowrap tabular-nums" style={{ color: "var(--sol-text-muted)" }}>{line.changes}</span></>}
            {line.answered && <><Dot /><span className="whitespace-nowrap tabular-nums font-medium" style={{ color: "var(--sol-violet)" }} data-org-strip-answered-line>{line.answered}</span></>}
          </button>
          {crumb && (
            <span className="min-w-0 flex items-center gap-1 text-[13px]" data-org-strip-current={crumb.proposal.short_id}>
              <Dot />
              <span className="min-w-0 truncate font-medium" style={{ color: "var(--sol-text)" }}>{crumb.proposal.title}</span>
              <button type="button" onClick={onClearCurrent} aria-label={`Leave ${crumb.proposal.title}`} title="Leave this proposal" className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-dim)" }} data-org-strip-clear>
                <X className="w-3.5 h-3.5" />
              </button>
            </span>
          )}
        </div>
      )}
      {open === "rows" && (
        <div className="min-h-0 overflow-y-auto border-t" style={{ maxHeight: rowsCap, borderColor: BORDER }} data-org-strip-rows>
          {rows.map((row) => <StripRowButton key={row.proposal._id} row={row} current={current === row.proposal.short_id} onPick={pick} />)}
        </div>
      )}
      {open === "card" && card && <StripExpandedCard row={card} batchConversationId={batchConversationId} cap={cardCap} onCollapse={onCollapse} />}
    </section>
  );
}

function Dot() {
  return <span aria-hidden className="px-1" style={{ color: "var(--sol-text-dim)" }}>·</span>;
}

/** One row: face, title, the words that explain a click (another thread),
 *  the count, and the staged answers when there are any. The hover carries
 *  the totals sentence, the age and how many are decided. */
function StripRowButton({ row, current, onPick }: { row: StripRow; current: boolean; onPick: (row: StripRow) => void }) {
  const { proposal, foreign, count, totals, answered, decided, total, age, author } = row;
  const decidedWords = decided === total && total > 0 ? `all ${total} decided` : decided > 0 ? `${decided} of ${total} decided` : null;
  const hover = [totals, age, decidedWords, foreign ? "from another thread" : null].filter((p): p is string => !!p).join(" · ");
  const state = answered ? "answered" : decided ? "decided" : "waiting";
  return (
    <button
      type="button"
      onClick={() => onPick(row)}
      title={hover}
      aria-current={current || undefined}
      className={cn("w-full h-9 px-4 flex items-center gap-2 text-left transition-colors hover:bg-sol-bg-highlight/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset", current && "shadow-[inset_2px_0_0_var(--sol-violet)]")}
      style={{ ["--tw-ring-color" as string]: "var(--sol-violet)" }}
      data-org-strip-row={proposal.short_id}
      data-org-strip-state={state}
      data-org-strip-foreign={foreign || undefined}
      data-org-strip-answered={answered || undefined}
    >
      {author.kind === "role" && author.handle ? <RoleFace role={{ handle: author.handle, name: author.name, avatar: author.avatar }} size={18} /> : <MessageSquareText className="w-4 h-4 shrink-0" style={{ color: "var(--sol-text-dim)" }} />}
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: "var(--sol-text)" }}>{proposal.title}</span>
      {foreign && <span className="shrink-0 text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-org-strip-foreign-words>from another thread</span>}
      {count && <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: "var(--sol-text-muted)" }} data-org-strip-count>{count}</span>}
      {answered > 0 && <span className="shrink-0 text-[11.5px] font-medium tabular-nums" style={{ color: "var(--sol-violet)" }}>{answered} answered</span>}
    </button>
  );
}

/** A proposal from another thread, opened under the line: its card, answering
 *  into this conversation's batch (the composer bridge keyed to it, read by
 *  useProposalBatch), with no send of its own, inside its own scroll. */
function StripExpandedCard({ row, batchConversationId, cap, onCollapse }: { row: StripRow; batchConversationId: string | null; cap: string; onCollapse: () => void }) {
  const composer = useMemo<ReviewComposer | null>(() => batchConversationId ? { quote() {}, submit() {}, conversationId: batchConversationId, canSend: true } : null, [batchConversationId]);
  const card = <EntityObjectCard refId={row.proposal.short_id} count={1} />;
  return (
    <div className="px-4 pb-3 pt-1 border-t flex flex-col min-h-0" style={{ borderColor: BORDER }} data-org-strip-expanded={row.proposal.short_id}>
      <div className="shrink-0 flex items-start gap-3 text-[11.5px]" style={{ color: "var(--sol-text-muted)" }}>
        <p className="min-w-0 flex-1">Written by {row.author.name ?? "another session"}. Your answers go out with your next message here, and that thread is told.</p>
        <button type="button" onClick={onCollapse} className="shrink-0 hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }} data-org-strip-collapse>Close</button>
      </div>
      <div className="mt-2 min-h-0 overflow-y-auto" style={{ maxHeight: cap }} data-org-strip-card-scroll>
        {composer ? <ReviewComposerContext.Provider value={composer}>{card}</ReviewComposerContext.Provider> : card}
      </div>
    </div>
  );
}

function LinkLine({ line, onSwitchWorkspace }: { line: LinkLineState; onSwitchWorkspace: (teamId: string | null) => void }) {
  return (
    <p className="px-4 pt-2.5 pb-1 text-[12px] flex items-center gap-2" style={{ color: "var(--sol-text-secondary)" }} data-org-link-line={line.kind}>
      {line.kind === "foreign" && (
        <>
          <span className="min-w-0 flex-1 truncate">{line.shortId} is in {line.workspaceName}.</span>
          <button type="button" onClick={() => onSwitchWorkspace(line.teamId)} className="shrink-0 font-medium hover:underline underline-offset-2" style={{ color: "var(--sol-violet)" }}>Switch</button>
        </>
      )}
      {line.kind === "unreadable" && <span>{line.shortId} is not a proposal you can read.</span>}
      {line.kind === "loading" && <span style={{ color: "var(--sol-text-dim)" }}>Looking for {line.shortId}…</span>}
    </p>
  );
}
