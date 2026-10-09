"use client";
// One record group of a records proposal (org-staffing.md S9): a collapsed
// row with the project's or plan's title, one totals line and the three
// answers; open, the records behind it as numbered sentences, twenty at a
// time. One answer per group: the rows carry no controls, and the number a
// row shows is the one a person writes back with ("leave out #3").
import React, { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { OrgChangeStatus, OrgReplyVerdict } from "@codecast/shared/contracts/orgProposal";
import { cn } from "../../lib/utils";
import { useOrgHover } from "./proposalContexts";
import type { RecordGroupCard, RecordRow } from "./proposalSubjects";
import { AnswerControls, AT, Clamp, FailNote, LEDGER_HAIR, LEDGER_INKS, LEDGER_STOP, LedgerWord, LedgerYou, Sentence, SLOT, StateWord, useAnswerField, useFocusScroll, type LedgerLayout, type SubjectAnswer } from "./ProposalSubjectCard";
import { StagedBand, stagedWash } from "./StagedBand";
import { useWatchEffect } from "../../hooks/useWatchEffect";

export const RECORD_PAGE = 20;

const GROUP_ASKS: Partial<Record<OrgReplyVerdict, string>> = {
  reject: "Why not? Say which records to leave out, by number, or what to change.",
  note: "Say something about these records",
  approve: "Say something about these records",
};

const QUIET = "text-[color:var(--ink-quiet)]";
const MUTED = "text-[color:var(--sol-text-muted)]";
// The chevron column is narrower than a card's number column; the gutter is the card's.
const GRID: Record<LedgerLayout, string> = {
  narrow: "grid-cols-[16px_minmax(0,1fr)]",
  wide: "grid-cols-[16px_minmax(0,1fr)_196px]",
  auto: "grid-cols-[16px_minmax(0,1fr)] [@container_(min-width:561px)]:grid-cols-[16px_minmax(0,1fr)_196px]",
};

/** Where the group stands once nothing waits, or while parts of it landed:
 *  "Applied", "Applying 10 of 18", "Rejected", "12 applied, 2 failed". */
export function groupStateWords(card: RecordGroupCard): { words: string; status: OrgChangeStatus | "mixed" } | null {
  const n = (...statuses: OrgChangeStatus[]) => card.rows.filter((r) => statuses.includes(r.status)).length;
  const total = card.rows.length;
  if (card.status === "proposed") return null;
  if (card.status === "applied") return { words: "Applied", status: "applied" };
  if (card.status === "accepted") return { words: n("applied") ? `Applying ${n("applied")} of ${total}` : "Approved, applying", status: "accepted" };
  if (card.status === "skipped") return { words: "Rejected", status: "skipped" };
  const parts = [n("applied") && `${n("applied")} applied`, n("accepted") && `${n("accepted")} approved`, n("skipped") && `${n("skipped")} rejected`, n("failed") && `${n("failed")} failed`].filter(Boolean);
  return { words: parts.join(", "), status: "mixed" };
}

export function RecordGroupRow({ card, answer, onAnswer, open, onOpen, lone, focusSeq, revisedNew, layout, className }: {
  card: RecordGroupCard;
  answer: SubjectAnswer | null;
  /** Put, replace or withdraw the group's answer. Absent: read only. */
  onAnswer?: (a: SubjectAnswer | null) => void;
  open: boolean;
  onOpen: (v: boolean) => void;
  /** The proposal's only group: it carries the proposal's totals and opens with "Show the N records". */
  lone: boolean;
  /** The store's focus names a record: the row is marked, the group opens to it. */
  focusSeq?: number | null;
  /** A revision landed on the group since the reader last looked (S18): a staged answer was withdrawn, and the row says so. */
  revisedNew?: boolean;
  layout?: "wide" | "narrow";
  className?: string;
}) {
  const hover = useOrgHover();
  const rootRef = useRef<HTMLDivElement>(null);
  const focusAt = focusSeq != null ? card.rows.findIndex((r) => r.seq === focusSeq) : -1;
  useFocusScroll(rootRef, focusAt >= 0);
  const [shown, setShown] = useState(RECORD_PAGE);
  // The focused record is paged in and the group opened once, when the focus lands.
  useWatchEffect(() => {
    if (focusAt < 0) return;
    setShown((s) => Math.max(s, Math.ceil((focusAt + 1) / RECORD_PAGE) * RECORD_PAGE));
    onOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAt]);

  const retry = card.failed > 0;
  const { open: fieldOpen, setOpen: setFieldOpen, field: replyField } = useAnswerField(answer, onAnswer, card.waiting > 0, GROUP_ASKS);
  const staged = !!answer && !!onAnswer && card.waiting > 0;
  const pendingText = answer?.text?.trim() ? answer.text : null;
  const stateWords = groupStateWords(card);
  const mode: LedgerLayout = layout ?? "auto";
  const n = card.rows.length;
  const rows = card.rows.slice(0, shown);
  const remaining = n - rows.length;
  const field = replyField({});
  const stored = card.reply?.text?.trim() ? card.reply : null;

  // The gutter: the controls while the group waits and nothing is staged, else where it stands.
  const slot = card.waiting > 0 && onAnswer && !staged
    ? <>{stateWords && <StateWord status={stateWords.status} words={stateWords.words} className="mr-1" />}<AnswerControls answer={answer} retry={retry} onAnswer={onAnswer} open={fieldOpen} onOpen={setFieldOpen} /></>
    : stateWords ? <StateWord status={stateWords.status} words={stateWords.words} /> : null;

  return (
    <div
      ref={rootRef}
      className={cn("not-prose min-w-0 border-t text-left", LEDGER_INKS, !layout && "[container-type:inline-size]", className)}
      style={{ borderColor: LEDGER_HAIR }}
      data-subject={card.key}
      data-subject-kind="group"
      data-subject-status={card.status}
      data-change-ids={card.change_ids.join(" ")}
      data-subject-answer={answer?.verdict}
      data-group-count={n}
      data-focused={focusAt >= 0 || undefined}
      data-revised-new={revisedNew || undefined}
      data-layout={mode}
    >
      <div className={cn("grid items-baseline pt-[13px] pb-[14px]", GRID[mode])} style={{ "--verdict-gap": card.waiting > 0 ? "12px" : "4px" } as React.CSSProperties}>
        <button
          type="button"
          className="col-span-2 col-start-1 -ml-1 flex min-w-0 items-baseline gap-1 rounded-sm pl-1 text-left hover:bg-[color-mix(in_srgb,var(--sol-border)_12%,transparent)]"
          aria-expanded={open}
          onClick={(e) => { e.stopPropagation(); onOpen(!open); }}
          onKeyDown={LEDGER_STOP.onKeyDown}
          onPointerDown={LEDGER_STOP.onPointerDown}
          data-group-toggle
        >
          <ChevronRight aria-hidden className={cn("relative top-[2px] h-3 w-3 shrink-0 transition-transform [transition-duration:120ms] motion-reduce:transition-none", QUIET, open && "rotate-90")} />
          <span className="min-w-0 text-[13.5px] font-bold leading-[20px] text-[color:var(--sol-text)] [overflow-wrap:anywhere]">{card.title}</span>
          {card.kindWord && <span className={cn("shrink-0 text-[11px] leading-[20px]", QUIET)}>{card.kindWord}</span>}
        </button>
        {slot && <div className={cn(SLOT, AT.verdicts[mode])} {...LEDGER_STOP} data-subject-verdicts>{slot}</div>}
        <p className={cn("col-start-2 m-0 mt-0.5 text-[12.5px] leading-[18px] [text-wrap:pretty]", MUTED)} data-group-totals>{card.totals}</p>
        {revisedNew && <p className="org-pop-in col-start-2 m-0 mt-1 text-[11px] leading-[18px] text-[color:var(--ink-violet)]">Revised since you last looked</p>}

        {!staged && stored && <div className="col-start-2 min-w-0"><LedgerYou text={stored.text!} onEdit={onAnswer && card.waiting > 0 ? () => setFieldOpen(true) : undefined} className="mt-1.5" data-subject-you={stored.verdict} /></div>}

        {(staged || field) && (
          <div className="col-start-2 mt-2 min-w-0" {...LEDGER_STOP} data-answer-area>
            {staged && (
              <StagedBand
                key="band"
                answer={answer}
                retry={retry}
                onUndo={() => { onAnswer?.(null); setFieldOpen(false); }}
                you={!fieldOpen && pendingText ? <LedgerYou text={pendingText} onEdit={() => setFieldOpen(true)} data-subject-you={answer.verdict} /> : undefined}
                joined={!!field}
              />
            )}
            {field && <div key="field" className={cn(staged && "rounded-b-md px-2.5 pb-2")} style={staged ? { background: stagedWash(answer.verdict) } : undefined}>{field}</div>}
          </div>
        )}

        {lone && !open && (
          <div className="col-start-2 mt-1" {...LEDGER_STOP}>
            <LedgerWord className="-ml-2" onClick={() => onOpen(true)} data-group-show={n}>Show the {n} records</LedgerWord>
          </div>
        )}

        {open && (
          <div className="col-start-2 mt-2 min-w-0" {...LEDGER_STOP}>
            <ol className="m-0 list-none p-0" data-group-rows={rows.length}>
              {rows.map((row) => <RecordLine key={row.seq} row={row} groupStatus={card.status} focused={row.seq === focusSeq} onHover={hover} />)}
            </ol>
            {remaining > 0 && (
              <LedgerWord className="-ml-2 mt-1" onClick={() => setShown((s) => s + RECORD_PAGE)} data-group-more={remaining}>Show {Math.min(RECORD_PAGE, remaining)} more</LedgerWord>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const ROW_WORDS: Partial<Record<OrgChangeStatus, [string, string]>> = {
  applied: ["applied", "text-[color:var(--ink-green)]"],
  accepted: ["approved", "text-[color:var(--ink-cyan)]"],
  skipped: ["rejected", QUIET],
};

/** One record: its number, the sentence with the record's title in medium
 *  weight (struck when the record is being closed), the reason, and a
 *  failure's note. A row whose status differs from its group's says so. */
function RecordLine({ row, groupStatus, focused, onHover }: { row: RecordRow; groupStatus: RecordGroupCard["status"]; focused: boolean; onHover: ((id: string | null) => void) | null }) {
  const differs = row.status !== "proposed" && row.status !== groupStatus;
  const word = differs ? ROW_WORDS[row.status] : undefined;
  return (
    <li
      className="m-0 flex gap-2 py-[3px]"
      data-record-row={row.seq}
      data-record-status={row.status}
      data-focused={focused || undefined}
      onMouseEnter={onHover ? () => onHover(row.change._id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <span className={cn("w-9 shrink-0 font-mono text-[11px] leading-[20px]", QUIET)} data-record-seq>#{row.seq}</span>
      <div className="min-w-0 flex-1">
        <p className={cn("m-0 text-[12.5px] leading-[20px] [overflow-wrap:anywhere] [text-wrap:pretty]", row.closed ? "text-[color:var(--sol-text-dim)]" : row.status === "skipped" ? QUIET : "text-[color:var(--sol-text)]")}>
          <Sentence text={row.sentence} span={row.subjectSpan} name="font-medium" />
          {word && <span className={cn("ml-1.5 text-[11px]", word[1])} data-record-word={row.status}>{word[0]}</span>}
        </p>
        {row.reason && <Clamp className={cn("text-[12.5px] leading-[20px]", QUIET)}>{row.reason}</Clamp>}
        {row.failed !== undefined && <FailNote note={row.failed} className="mt-0.5" />}
      </div>
    </li>
  );
}
