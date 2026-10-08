"use client";
// What waits on you (D7), as ONE line above the Org conversation: "4 wait on
// you: 2 proposals · 1 decision · Calling lead is stuck", then the answers
// staged for the next send, and the proposal the address names as a
// breadcrumb with an x that clears it. The count is needsYou's
// (staffingModel), the same one the sidebar's Org row shows. The line opens
// the rows on click (proposals oldest first, then decisions, then stuck
// roles, capped at 38% of the column with their own scroll) and they close
// after a pick. A proposal pick scrolls the thread to its card; a decision
// opens the sheet of what it is about (the goal or project it cites, else the
// role that asked); a stuck role opens the role's sheet. A proposal written
// on another thread has no card here, so its pick opens the card under the
// line instead, capped at half the column or 480px with its own scroll: the
// answers join this conversation's batch and the send tells that thread.
// Above the line, one line for a `?proposal=` the rows do not hold.
import { useMemo, useState } from "react";
import { ChevronDown, MessageSquareText, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { EntityObjectCard } from "../EntityObjectCard";
import { ReviewComposerContext, type ReviewComposer } from "../reviewContext";
import { RoleFace } from "./RoleFace";
import { useOrgOpen } from "./company/orgOpenContext";
import { type StripRow } from "./orgScreenModel";
import { ORG_BAND, ORG_GUTTER, ORG_INNER_RULE, ORG_RULE } from "./orgFrame";
import { decisionSubject, needsYouLine, needsYouParts, type NeedsYouItem, type NeedsYouPartKind, type NeedsYouTarget } from "./staffingModel";

export type { StripRow };

/** A `?proposal=` the rows do not hold: where it is, or that it cannot be read. */
export type LinkLineState =
  | { kind: "foreign"; shortId: string; workspaceName: string; teamId: string | null }
  | { kind: "unreadable" | "loading"; shortId: string };

export type OpenProposalsStripProps = {
  rows: StripRow[];
  /** The rest of what waits on you: decisions the org routed to you and roles
   *  stuck on you (useOrgAsks). Proposal items here are ignored: `rows` holds them. */
  asks?: readonly NeedsYouItem[];
  /** Whether this workspace holds a goal or project short id, so a decision
   *  that cites one opens it rather than the role that asked. */
  holds?: (ref: string) => boolean;
  /** A decision or stuck role row: open the sheet of what it is about.
   *  Without it the row opens through the screen's OrgOpenContext. */
  onOpen?: (target: NeedsYouTarget, item: NeedsYouItem) => void;
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
/** Each kind of what waits on you in its own colour; the dot takes the most
 *  pressing one's, so it points at the item it is about. Violet is the proposals' alone. */
const TONE: Record<NeedsYouPartKind, string> = { proposals: "var(--sol-violet)", decisions: "var(--sol-yellow)", stuck: "var(--sol-red)" };
/** The strip is a soft violet band, the one place on the frame that asks something of you. */
const BAND_BG = "color-mix(in srgb, var(--sol-violet) 6%, var(--sol-bg-alt))";

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

const NO_ASKS: readonly NeedsYouItem[] = [];
const holdsNothing = () => false;

export function OpenProposalsStrip({ rows, asks = NO_ASKS, holds = holdsNothing, onOpen, current, expanded, batchConversationId, linkLine, onPick, onCollapse, onClearCurrent, onSwitchWorkspace }: OpenProposalsStripProps) {
  const [listOpen, setListOpen] = useState(false);
  const [section, setSection] = useState<HTMLElement | null>(null);
  const columnHeight = useColumnHeight(section);
  const orgOpen = useOrgOpen();
  const decisions = asks.filter((a): a is Extract<NeedsYouItem, { kind: "decision" }> => a.kind === "decision");
  const stuck = asks.filter((a): a is Extract<NeedsYouItem, { kind: "blocked" }> => a.kind === "blocked");
  const line = needsYouLine(rows.length, [...decisions, ...stuck]);
  const parts = needsYouParts(rows.length, [...decisions, ...stuck]);
  const urgent = parts.at(-1)?.kind ?? "proposals";
  if (line.total === 0 && !linkLine) return null;
  const answered = rows.reduce((n, r) => n + r.answered, 0);
  const crumb = current ? rows.find((r) => r.proposal.short_id === current) ?? null : null;
  const card = expanded ? rows.find((r) => r.proposal.short_id === expanded) ?? null : null;
  // The rows when the person opened them; else the card a pick or a link
  // opened; else the line alone.
  const open = listOpen ? "rows" : card ? "card" : null;
  const rowsCap = columnHeight ? `${Math.round(columnHeight * STRIP_ROWS_SHARE)}px` : `${STRIP_ROWS_SHARE * 100}vh`;
  const cardCap = columnHeight ? `${Math.min(Math.round(columnHeight * STRIP_CARD_SHARE), STRIP_CARD_MAX_PX)}px` : `min(${STRIP_CARD_SHARE * 100}vh, ${STRIP_CARD_MAX_PX}px)`;
  const pick = (row: StripRow) => { setListOpen(false); onPick(row); };
  const openAsk = (item: NeedsYouItem) => {
    const target = item.kind === "decision" ? decisionSubject(item.item, item.role, holds) : item.kind === "blocked" ? { kind: "role" as const, ref: item.role.short_id } : null;
    setListOpen(false);
    if (!target) return;
    if (onOpen) onOpen(target, item); else orgOpen?.open(target.kind, target.ref);
  };
  return (
    <section ref={setSection} data-org-strip={line.total} data-org-strip-open={open ?? undefined} className="shrink-0 border-b flex flex-col min-h-0" style={{ background: BAND_BG, borderColor: ORG_RULE }}>
      {linkLine && <LinkLine line={linkLine} onSwitchWorkspace={onSwitchWorkspace} />}
      {line.total > 0 && (
        <div className={cn("shrink-0 flex items-center gap-1 min-w-0", ORG_BAND, ORG_GUTTER)} data-org-strip-head>
          <button
            type="button"
            onClick={() => setListOpen(!listOpen)}
            aria-expanded={listOpen}
            className="-mx-2 h-7 min-w-0 shrink flex items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-sol-bg-highlight/50 focus-visible:outline-none focus-visible:ring-2"
            style={{ color: "var(--sol-text-secondary)", ["--tw-ring-color" as string]: "var(--sol-violet)" }}
            data-org-strip-toggle
          >
            <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ background: TONE[urgent] }} data-org-strip-dot={urgent} />
            <span className="min-w-0 truncate">
              <span className="font-semibold" style={{ color: "var(--sol-violet)" }} data-org-strip-lead>{line.lead}:</span>{" "}
              {parts.map((part, i) => (
                <span key={part.kind} data-org-strip-part={part.kind}>{i > 0 && <Dot />}<span className={cn("tabular-nums", part.kind !== "proposals" && "font-medium")} style={{ color: TONE[part.kind] }}>{part.text}</span></span>
              ))}
              {answered > 0 && (
                <span><Dot /><span className="tabular-nums font-medium" style={{ color: "var(--sol-violet)" }} data-org-strip-answered-line>{answered} answered, waiting for your send</span></span>
              )}
            </span>
            {/* Always drawn, right after the words: the one sign the line opens into rows. */}
            <ChevronDown aria-hidden data-org-strip-chevron className={cn("w-3.5 h-3.5 shrink-0 transition-transform duration-150", listOpen && "rotate-180")} style={{ color: "var(--sol-text-dim)" }} />
          </button>
          <span className="flex-1" />
          {crumb && (
            <span className="min-w-0 max-w-[45%] shrink flex items-center gap-1 text-[12.5px]" data-org-strip-current={crumb.proposal.short_id}>
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
        <div className="min-h-0 overflow-y-auto border-t py-1" style={{ maxHeight: rowsCap, borderColor: ORG_INNER_RULE }} data-org-strip-rows>
          {rows.map((row) => <StripRowButton key={row.proposal._id} row={row} current={current === row.proposal.short_id} onPick={pick} />)}
          {decisions.map((d) => <AskRowButton key={d.key} item={d} onOpen={openAsk} />)}
          {stuck.map((b) => <AskRowButton key={b.key} item={b} onOpen={openAsk} />)}
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

/** A decision or a stuck role: the role's face, what it asks or what it
 *  said, and the word for which it is. A click opens the sheet. */
function AskRowButton({ item, onOpen }: { item: Extract<NeedsYouItem, { kind: "decision" | "blocked" }>; onOpen: (item: NeedsYouItem) => void }) {
  const role = item.role;
  const decision = item.kind === "decision";
  const text = decision ? item.item.question : `${item.role.name} is stuck`;
  const detail = decision ? (role ? `asked by ${role.name}` : null) : item.line;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      title={[text, detail].filter(Boolean).join(" · ")}
      className="w-full h-9 px-4 flex items-center gap-2 text-left transition-colors hover:bg-sol-bg-highlight/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset"
      style={{ ["--tw-ring-color" as string]: "var(--sol-violet)" }}
      data-org-strip-ask={item.key}
      data-org-strip-kind={item.kind}
    >
      {role ? <RoleFace role={role} size={18} /> : <MessageSquareText className="w-4 h-4 shrink-0" style={{ color: "var(--sol-text-dim)" }} />}
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="font-medium" style={{ color: "var(--sol-text)" }}>{text}</span>
        {detail && <span className="ml-2 text-[12px]" style={{ color: "var(--sol-text-muted)" }}>{detail}</span>}
      </span>
      <span className="shrink-0 text-[11.5px]" style={{ color: decision ? TONE.decisions : TONE.stuck }} data-org-strip-ask-word>{decision ? "decision" : "stuck"}</span>
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
    <div className="px-4 pb-3 pt-1 border-t flex flex-col min-h-0" style={{ borderColor: ORG_INNER_RULE }} data-org-strip-expanded={row.proposal.short_id}>
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
