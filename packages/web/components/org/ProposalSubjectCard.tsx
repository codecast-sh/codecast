"use client";
// One entry of the proposal ledger (docs/architecture/org-staffing.md S39):
// every change a proposal makes to one goal, one project, one role or one
// record, read as a plain sentence, the fields it moves with what was there
// before, the reason, and Accept and Skip. The only boxes are things a person
// can press; the rest is type on hairlines, and colour appears only on a
// priority dot, a state word and the frame's one filled button.
//
// Callback driven: no store, no router, no chart. The conversation's card, the
// org page's panel, the company document and the chart's strip all hand it a
// `SubjectCard` from `proposalSubjects` and their own verdict.
import React, { useRef, useState, type ButtonHTMLAttributes } from "react";
import Link from "next/link";
import { AlertTriangle, CheckSquare, Flag, FolderClosed, ListChecks, Sparkles } from "lucide-react";
import { editedOrgChange, isOrgChangeDecidable, type OrgChangeStatus } from "@codecast/shared/contracts/orgProposal";
import { cn } from "../../lib/utils";
import { PRIORITY_META } from "../charter/charterMeta";
import { Avatar } from "../tasks/TaskCommentStream";
import { OrgButton } from "./OrgButton";
import { RoleFace } from "./RoleFace";
import { TakeoverEdit } from "./TakeoverEdit";
import { CHIP_STATUS, GHOST } from "./orgMeta";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { subjectStatusWords, type FieldRow, type FieldValue, type SubjectCard } from "./proposalSubjects";
import type { ProposalTreeFace } from "./proposalTree";
import { syncEvidence } from "./staffingModel";

// ---------------------------------------------------------------- the face

export function Face({ face, size = 20, dim }: { face: ProposalTreeFace; size?: number; dim?: boolean }) {
  const style = dim ? { opacity: GHOST.opacity } : undefined;
  if (face.kind === "person") {
    return (
      <span className="inline-flex shrink-0 rounded-full p-[1.5px]" style={{ background: face.me ? "linear-gradient(135deg, var(--sol-cyan), var(--sol-blue))" : "color-mix(in srgb, var(--sol-border) 45%, transparent)", ...style }} data-face="person">
        <span className="inline-flex rounded-full p-[1px]" style={{ background: "var(--sol-card)" }}><Avatar name={face.name} image={face.image} size="sm" /></span>
      </span>
    );
  }
  if (face.kind === "role") return <span className="inline-flex shrink-0" style={style} data-face="role"><RoleFace role={{ handle: face.handle, name: face.name, avatar: face.avatar }} size={size} /></span>;
  if (face.kind === "session") {
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-md" style={{ width: size, height: size, background: GHOST.fill, color: GHOST.color, ...style }} data-face="session">
        <Sparkles className="h-3 w-3" />
      </span>
    );
  }
  if (face.kind === "goal") {
    return (
      <span className="inline-flex shrink-0 items-center justify-center rounded-md" style={{ width: size, height: size, background: face.proposed ? GHOST.fill : "color-mix(in srgb, var(--sol-cyan) 14%, transparent)", color: face.proposed ? GHOST.color : "var(--sol-cyan)", ...style }} data-face="goal">
        <Flag className="h-3 w-3" />
      </span>
    );
  }
  if (face.kind === "record") {
    const Icon = face.record === "task" ? CheckSquare : face.record === "plan" ? ListChecks : FolderClosed;
    return (
      <span className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size, color: "var(--sol-text-muted)", ...style }} data-face="record">
        <Icon className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full" style={{ width: size, height: size, border: CHIP_STATUS.failed.border, color: CHIP_STATUS.failed.color, ...style }} data-face="unknown">
      <AlertTriangle className="h-3 w-3" />
    </span>
  );
}

// ---------------------------------------------------------------- inks and pieces

/** The ledger's inks, each a mix of theme variables, lifted toward the text
 *  colour on a dark ground. Every root that draws ledger type carries them. */
export const LEDGER_INKS = "[--ink-quiet:var(--sol-text-dim)] dark:[--ink-quiet:color-mix(in_srgb,var(--sol-text-dim)_55%,var(--sol-text-muted))] [--ink-violet:var(--sol-violet)] dark:[--ink-violet:color-mix(in_srgb,var(--sol-violet)_68%,var(--sol-text))] [--ink-red:var(--sol-red)] dark:[--ink-red:color-mix(in_srgb,var(--sol-red)_80%,var(--sol-text))] [--ink-green:color-mix(in_srgb,var(--sol-green)_87%,var(--sol-text))] [--ink-cyan:color-mix(in_srgb,var(--sol-cyan)_88%,var(--sol-text))]";
/** A rule between entries, and the stronger one over the closing row. */
export const LEDGER_HAIR = "color-mix(in srgb, var(--sol-border) 30%, transparent)";
export const LEDGER_RULE = "color-mix(in srgb, var(--sol-border) 60%, transparent)";
/** A link inside ledger type: one thin underline, the ink it sits in. */
export const LEDGER_LINK = "cursor-pointer underline decoration-1 underline-offset-[3px] [text-decoration-color:color-mix(in_srgb,currentColor_45%,transparent)] transition-colors [transition-duration:120ms] motion-reduce:transition-none hover:text-[color:var(--sol-text)]";
/** A button that is a word: Skip, Chart, Ask. */
export const LEDGER_WORD = "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-normal leading-none no-underline text-[color:var(--sol-text-muted)] transition-colors [transition-duration:120ms] motion-reduce:transition-none hover:bg-[color-mix(in_srgb,var(--sol-border)_16%,transparent)] hover:text-[color:var(--sol-text)] disabled:cursor-not-allowed disabled:opacity-45";

const TEXT = "text-[color:var(--sol-text)]";
const SOFT = "text-[color:var(--sol-text-secondary)]";
const MUTED = "text-[color:var(--sol-text-muted)]";
const QUIET = "text-[color:var(--ink-quiet)]";
const RED = "text-[color:var(--ink-red)]";
const STRUCK = "line-through decoration-1";
const EASE = "transition-colors duration-200 motion-reduce:transition-none";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
/** A control's press, key or pointer never reaches the frame around it (a card that opens on a click). */
export const LEDGER_STOP = { onClick: stop, onKeyDown: stop, onPointerDown: stop } as const;

export function LedgerWord({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn(LEDGER_WORD, className)} {...rest} />;
}

/**
 * The ledger's closing line, under a stronger rule: word buttons at the left,
 * the frame's one filled button and a word at the right, or what happened in
 * words once nothing waits. When it cannot fit one line the verdicts take the
 * upper one.
 */
export function LedgerClosingRow({ left, accept, skip, outcome, sticky, className }: {
  left?: React.ReactNode;
  accept?: { label: string; onClick: () => void };
  skip?: { label: string; onClick: () => void };
  outcome?: React.ReactNode;
  /** Stay at the foot of a scrolling column, on the page's own ground. */
  sticky?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("not-prose flex flex-wrap-reverse items-center gap-x-0.5 gap-y-1.5 border-t pt-3", LEDGER_INKS, sticky && "sticky bottom-0 bg-[var(--sol-bg)] pb-1", className)}
      style={{ borderColor: LEDGER_RULE }}
      {...LEDGER_STOP}
      data-ledger-close
    >
      {left != null && <div className="-ml-2 flex items-center gap-0.5">{left}</div>}
      <div className="ml-auto flex items-center gap-0.5">
        {accept && <OrgButton primary size="sm" onClick={accept.onClick} data-accept>{accept.label}</OrgButton>}
        {skip && <LedgerWord className="-mr-2" onClick={skip.onClick} data-skip>{skip.label}</LedgerWord>}
        {outcome != null && <span className={cn("text-[12px] leading-7", MUTED)} data-proposal-outcome>{outcome}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- values

/** A value as the words a person reads. */
export function fieldValueText(value: FieldValue): string {
  switch (value.kind) {
    case "text": case "none": return value.text;
    case "face": return value.face.name;
    case "priority": return PRIORITY_META[value.priority].label;
    case "names": return value.summary ?? value.names.join(", ");
    case "measures": return value.measures.map((m) => (m.target ? `${m.name}, target ${m.target}` : m.name)).join("; ");
  }
}

/** A face at the height of a line of ledger type. A person's avatar has one
 *  drawn size, so it is scaled into the same box as the rest. */
function SmallFace({ face }: { face: ProposalTreeFace }) {
  // A face nobody could name draws no mark: the name stands alone.
  if (face.kind === "unknown") return null;
  return (
    <span className="relative -top-px mr-1.5 inline-flex h-[15px] w-[15px] items-center justify-center align-middle" data-subject-face={face.kind}>
      {face.kind === "person" ? <span className="inline-flex shrink-0 scale-[0.6]"><Face face={face} /></span> : <Face face={face} size={15} />}
    </span>
  );
}

/** A list that stands behind a summary until asked for ("9 projects, through the goals below"). */
function Names({ value, struck }: { value: Extract<FieldValue, { kind: "names" }>; struck: boolean }) {
  const [open, setOpen] = useState(false);
  const list = value.names.join(", ");
  if (!value.summary) return <span className={struck ? STRUCK : undefined}>{list}</span>;
  return (
    <span>
      {open ? list : value.summary}{" "}
      <button type="button" className={cn(LEDGER_LINK, QUIET, "text-[11px]")} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} onKeyDown={stop} onPointerDown={stop} data-field-show>{open ? "hide" : "show"}</button>
    </span>
  );
}

/** One value. `was`: the side being left, drawn plainer (a priority without
 *  its dot). `struck`: a real value that goes away; its face is never struck.
 *  A person is always named: the sentence says "you", the field says who. */
function Value({ value, was, struck = false }: { value: FieldValue; was?: boolean; struck?: boolean }) {
  switch (value.kind) {
    case "none": return <span className={QUIET}>{value.text}</span>;
    case "text": return <span className={struck ? STRUCK : undefined}>{value.text}</span>;
    case "face": return <span><SmallFace face={value.face} /><span className={struck ? STRUCK : undefined}>{value.face.name}</span></span>;
    case "priority": {
      const meta = PRIORITY_META[value.priority];
      if (was) return <span className={struck ? STRUCK : undefined}>{meta.label}</span>;
      return <span className="inline-flex items-center gap-1.5 font-semibold"><i aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />{meta.label}</span>;
    }
    case "names": return <Names value={value} struck={struck} />;
    case "measures": return (
      <>
        {value.measures.map((m, i) => (
          // One measure per line; a line that wraps hangs. The target is the author's words, never parsed.
          <span key={i} className={cn("block pl-[2ch] [text-indent:-2ch]", struck && STRUCK)}>{m.name}{m.target && <><span className={QUIET}>, target </span>{m.target}</>}</span>
        ))}
      </>
    );
  }
}

/** One field: its label, then the value, or what was there, an arrow, and
 *  what it becomes. Before and after share a line when they fit; when they do
 *  not, the after drops to its own line behind the arrow. */
function Field({ row, tone }: { row: FieldRow; tone: string }) {
  const { before, after, op } = row;
  const same = op === "same";
  const shown = same ? null : before;
  // Replaced or cleared: the old value is struck. A list that only gains or loses entries keeps the rest, so it is not.
  const gone = !!shown && shown.kind !== "none" && (op === "change" || op === "clear");
  // Entries a change takes away, with no list in hand to compare.
  const taken = op === "remove" && !before;
  return (
    <>
      <dt className={cn("m-0 whitespace-nowrap text-[11px] font-normal leading-[20px]", QUIET)}>{row.label}</dt>
      <dd
        className={cn("m-0 flex min-w-0 flex-wrap gap-x-[1ch] text-[12.5px] leading-[20px] [overflow-wrap:anywhere]", EASE, tone)}
        data-field={row.key}
        data-field-op={op}
        data-field-before={before ? fieldValueText(before) : undefined}
        data-field-after={after ? fieldValueText(after) : undefined}
      >
        {shown && <span className={cn("min-w-0 max-w-full", QUIET)}><Value value={shown} was struck={gone} /></span>}
        {after && (shown ? (
          <span className="flex min-w-0 max-w-full gap-x-[1ch]">
            <span aria-hidden className={cn("flex-none font-medium", MUTED)}>→</span>
            <span className="sr-only">becomes</span>
            <span className="min-w-0"><Value value={after} /></span>
          </span>
        ) : (
          <span className={cn("min-w-0 max-w-full", taken && QUIET)}><Value value={after} was={taken} struck={taken} /></span>
        ))}
        {same && <span className={QUIET}>no change</span>}
      </dd>
    </>
  );
}

// ---------------------------------------------------------------- verdicts and state

/** Where a decided entry stands, in a word. Cyan while the verdict is on its
 *  way, green once it landed; the word stays mounted so the colour settles. */
function StateWord({ status }: { status: OrgChangeStatus | SubjectCard["status"] }) {
  if (status !== "accepted" && status !== "applied" && status !== "skipped") return null;
  const ink = status === "accepted" ? "text-[color:var(--ink-cyan)]" : status === "applied" ? "text-[color:var(--ink-green)]" : QUIET;
  return <span className={cn("org-pop-in text-[12px] leading-[21px] transition-colors [transition-duration:400ms] motion-reduce:transition-none", ink)} data-subject-state={status}>{status === "skipped" ? "Skipped" : "Accepted"}</span>;
}

function Verdicts({ retry, filled, onAccept, onSkip }: { retry: boolean; filled?: boolean; onAccept: () => void; onSkip: () => void }) {
  // One filled button per frame: only a card that stands alone fills its Accept.
  const fill = !!filled && !retry;
  return (
    <>
      <OrgButton size="sm" quiet={!fill} primary={fill} onClick={onAccept} data-subject-accept>{retry ? "Retry" : "Accept"}</OrgButton>
      <LedgerWord className="-mr-2" onClick={onSkip} data-subject-skip>Skip</LedgerWord>
    </>
  );
}

function FailNote({ note, className }: { note: string; className?: string }) {
  return <p className={cn("m-0 text-[12.5px] leading-[1.55]", TEXT, className)} data-failed-note><b className={cn("font-semibold", RED)}>{note ? "Failed:" : "Failed."}</b>{note ? ` ${note}` : ""}</p>;
}

/** The subject's name is the sentence's one bold run. */
function Sentence({ text, span, name }: { text: string; span: [number, number] | null; name: string }) {
  if (!span) return <>{text}</>;
  return <>{text.slice(0, span[0])}<b className={name}>{text.slice(span[0], span[1])}</b>{text.slice(span[1])}</>;
}

// ---------------------------------------------------------------- layout

// Wide (over 560px of card): number, reading column, verdict gutter. Narrow:
// number and reading column, with the verdicts in a right aligned row under
// the entry. With no layout given the card asks its own width. Tailwind reads
// these strings whole, so each form is written out.
const AT = {
  grid: {
    narrow: "[--num:20px] grid-cols-[var(--num)_minmax(0,1fr)]",
    wide: "[--num:28px] grid-cols-[var(--num)_minmax(0,1fr)_140px]",
    auto: "[--num:20px] grid-cols-[var(--num)_minmax(0,1fr)] [@container_(min-width:561px)]:[--num:28px] [@container_(min-width:561px)]:grid-cols-[var(--num)_minmax(0,1fr)_140px]",
  },
  pad: {
    narrow: "pt-[13px] pb-[14px]",
    wide: "pt-[14px] pb-[15px]",
    auto: "pt-[13px] pb-[14px] [@container_(min-width:561px)]:pt-[14px] [@container_(min-width:561px)]:pb-[15px]",
  },
  num: {
    narrow: "text-[10.5px] leading-[20px]",
    wide: "text-[11px] leading-[21px]",
    auto: "text-[10.5px] leading-[20px] [@container_(min-width:561px)]:text-[11px] [@container_(min-width:561px)]:leading-[21px]",
  },
  sentence: {
    narrow: "text-[13.5px] leading-[20px]",
    wide: "text-[14px] leading-[21px]",
    auto: "text-[13.5px] leading-[20px] [@container_(min-width:561px)]:text-[14px] [@container_(min-width:561px)]:leading-[21px]",
  },
  // One text line tall: the 28px buttons overhang it, so they never push the fields down.
  verdicts: {
    narrow: "col-start-2 order-last mt-[var(--verdict-gap)]",
    wide: "col-start-3",
    auto: "col-start-2 order-last mt-[var(--verdict-gap)] [@container_(min-width:561px)]:order-none [@container_(min-width:561px)]:col-start-3 [@container_(min-width:561px)]:mt-0",
  },
  groupState: {
    narrow: "col-start-2 mt-2",
    wide: "col-start-3",
    auto: "col-start-2 mt-2 [@container_(min-width:561px)]:col-start-3 [@container_(min-width:561px)]:mt-0",
  },
} as const;
const SLOT = "flex h-[21px] items-center justify-self-end gap-0.5 whitespace-nowrap";

// ---------------------------------------------------------------- the entry

export type SubjectVerdict = (changeIds: string[], verdict: "accept" | "skip", opts?: { leave_sessions?: boolean }) => void;

export type ProposalSubjectCardProps = {
  card: SubjectCard;
  /** "full": the sentence, the fields, the reasons, the verdicts. "row": one line (face, sentence, state, Accept and Skip) for a long fold; it opens on pick. */
  variant?: "full" | "row";
  /** The card's place in its list, from 1: the number column. Absent on a card that stands alone, which then draws no rule and no padding of its own. */
  ordinal?: number;
  /** Where the verdicts sit. Absent: the card asks its own width (wide over 560px). */
  layout?: "wide" | "narrow";
  /** A card that stands alone in its frame: its Accept is the frame's one filled button. */
  lead?: boolean;
  /** A card that stands alone: the line above the sentence ("First of nine in <the proposal>"). */
  place?: React.ReactNode;
  /** Absent: read only. */
  onDecide?: SubjectVerdict;
  /** "Ask about this", in the entry's foot line. */
  onAsk?: () => void;
  /** "Edit", in the entry's foot line; shown only when set, and only while the card waits. */
  onEdit?: () => void;
  /** The host's edit form, under the entry. */
  editor?: React.ReactNode;
  /** What accepting would take over (R1). The card owns the "leave them" box and sends the choice with Accept. */
  takeover?: { phrase: string };
  selected?: boolean;
  onPick?: () => void;
  /** Revised since the reader last looked (S18). */
  revisedNew?: boolean;
  /** "named" (default): the sentence names its subject, in bold. "this": it says "this goal", for a host that titles the subject itself. */
  sentence?: "named" | "this";
  className?: string;
};

type Group = { key: string; change: OrgProposalChange | null; rows: FieldRow[]; reasons: string[] };

/** The card's rows and reasons as the groups it reads in. A card of one
 *  change, or one that creates its subject, is one group: what rides along is
 *  in the rows. Several changes to a subject that exists read change by
 *  change, each with its own reason; so does any card whose changes ended
 *  differently, because each then carries its own state. */
function groupsOf(card: SubjectCard, split: boolean): Group[] {
  if (!split && (card.isNew || card.changes.length <= 1)) {
    return card.rows.length || card.reasons.length ? [{ key: "all", change: null, rows: card.rows, reasons: card.reasons }] : [];
  }
  // The model already dropped repeats; a reason goes to the first change that gave it.
  const unclaimed = new Set(card.reasons);
  return card.changes
    .map((change): Group => {
      const own = new Set([change.rationale, syncEvidence(editedOrgChange(change.change, change.edits)) ?? ""].map((r) => r?.trim().toLowerCase() ?? "").filter(Boolean));
      const reasons = card.reasons.filter((r) => unclaimed.has(r) && own.has(r.toLowerCase()));
      for (const r of reasons) unclaimed.delete(r);
      return { key: change._id, change, rows: card.rows.filter((r) => r.seq === change.seq), reasons };
    })
    .filter((g) => split || g.rows.length > 0 || g.reasons.length > 0);
}

export function ProposalSubjectCard({ card, variant = "full", ordinal, layout, lead, place, onDecide, onAsk, onEdit, editor, takeover, selected, onPick, revisedNew, sentence = "named", className }: ProposalSubjectCardProps) {
  const [leave, setLeave] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // An entry decided in this view keeps its height, so nothing jumps under the
  // pointer while someone accepts down the list. It folds to its sentence the
  // next time it mounts.
  const decidedAtMount = useRef(card.status === "applied" || card.status === "skipped").current;
  const settled = decidedAtMount && (card.status === "applied" || card.status === "skipped");

  const members = [...card.changes, ...card.carried, ...card.riders];
  const drawn = new Set(card.changes.map((c) => c._id));
  // Its changes ended differently: each group then says where it stands.
  const split = card.status === "mixed" || (card.status === "failed" && card.failed.length < members.length);
  const state = split ? "mixed" : card.status;
  /** The members still waiting, in the order a verdict is sent. */
  const waiting = (only?: (c: OrgProposalChange) => boolean) => {
    const open = new Set(members.filter((c) => isOrgChangeDecidable(c.status) && (!only || only(c))).map((c) => c._id));
    return card.change_ids.filter((id) => open.has(id));
  };
  const decide = (ids: string[], verdict: "accept" | "skip") => {
    if (ids.length > 0) onDecide?.(ids, verdict, verdict === "accept" && takeover && leave ? { leave_sessions: true } : undefined);
  };
  const verdicts = (ids: () => string[], retry: boolean, filled?: boolean) => <Verdicts retry={retry} filled={filled} onAccept={() => decide(ids(), "accept")} onSkip={() => decide(ids(), "skip")} />;
  const words = <span className={cn("text-[12px] leading-[21px]", MUTED)} data-subject-state={state}>{subjectStatusWords(card)}</span>;
  // What rides along (a limit, a task its plan closes) has no group of its own: it goes with the first group that still waits.
  const firstWaiting = card.changes.find((c) => isOrgChangeDecidable(c.status));
  const loose = () => waiting((c) => !drawn.has(c._id));

  const text = sentence === "this" ? card.sentenceThis : card.sentence;
  const span = sentence === "this" ? null : card.subjectSpan;
  const sentenceTone = state === "applied" ? MUTED : state === "skipped" ? QUIET : TEXT;
  const nameTone = state === "applied" ? cn("font-semibold", SOFT) : state === "skipped" ? "font-medium" : "font-bold";
  const numberTone = card.status === "failed" ? RED : QUIET;
  const root = {
    "data-subject": card.key,
    "data-subject-kind": card.kind,
    "data-subject-status": card.status,
    "data-change-ids": card.change_ids.join(" "),
    "data-subject-variant": variant,
    "data-selected": selected || undefined,
    "data-revised-new": revisedNew || undefined,
  };
  const pickKey = onPick ? (e: React.KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(); } } : undefined;

  if (variant === "row") {
    return (
      <div
        className={cn("not-prose flex min-w-0 items-center gap-2 py-1.5 text-left", LEDGER_INKS, ordinal != null && "border-t", onPick && "cursor-pointer", className)}
        style={{ borderColor: LEDGER_HAIR }}
        role={onPick ? "button" : undefined}
        tabIndex={onPick ? 0 : undefined}
        aria-expanded={onPick ? false : undefined}
        onClick={onPick}
        onKeyDown={pickKey}
        {...root}
      >
        {ordinal != null && <span className={cn("w-5 shrink-0 text-[10.5px] tabular-nums leading-[20px]", numberTone)} data-subject-ordinal>{ordinal}</span>}
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px] font-normal leading-[20px]", EASE, sentenceTone)} title={text} data-subject-sentence>
          <SmallFace face={card.face} />
          <Sentence text={text} span={span} name={nameTone} />
        </span>
        <span className="flex h-[21px] shrink-0 items-center gap-0.5 whitespace-nowrap" {...LEDGER_STOP} data-subject-verdicts>
          {card.waiting === 0 ? (split ? words : <StateWord status={card.status} />) : !onDecide ? words : <>{split && words}{verdicts(() => waiting(), card.failed.length > 0)}</>}
        </span>
      </div>
    );
  }

  const mode = layout ?? "auto";
  const groups = settled && state === "skipped" ? [] : groupsOf(card, split);
  const groupTone = (status: OrgChangeStatus | SubjectCard["status"]) => (status === "applied" ? SOFT : status === "skipped" ? QUIET : TEXT);
  // The label gutter fits the longest label ("Measured by"), and widens for a card that carries a longer one.
  const gutter = Math.max(86, Math.ceil(Math.max(0, ...card.rows.map((r) => r.label.length)) * 6.7) + 6);
  // Notes with no group to sit under: the whole card failed, or something that rides along did.
  const looseNotes = [...new Set(card.failed.filter((f) => !split || !card.seqs.includes(f.seq)).map((f) => f.note))];
  const top = !split
    ? card.waiting === 0 ? <StateWord status={card.status} /> : onDecide ? verdicts(() => waiting(), card.status === "failed", lead) : words
    : onDecide && !firstWaiting && loose().length > 0 ? verdicts(loose, card.failed.length > 0) : words;
  const revisionKind = (seq: number) => card.changes.find((c) => c.seq === seq)?.revision?.kind;
  const sources = card.evidence;
  const foot = (!settled && (sources.length > 0 || (onEdit && card.waiting > 0))) || !!onAsk;

  return (
    <div
      className={cn("not-prose min-w-0 text-left", LEDGER_INKS, !layout && "[container-type:inline-size]", ordinal != null && "border-t", selected && "bg-[color-mix(in_srgb,var(--sol-violet)_5%,transparent)]", onPick && "cursor-pointer", className)}
      style={{ borderColor: LEDGER_HAIR }}
      onClick={onPick}
      data-layout={mode}
      data-settled={settled || undefined}
      {...root}
    >
      {place != null && <p className={cn("m-0 mb-[9px] text-[11px] leading-[17px]", QUIET)} data-subject-place>{place}</p>}
      <div
        className={cn("grid items-baseline", AT.grid[mode], ordinal != null && AT.pad[mode])}
        style={{ ...(ordinal == null ? { "--num": "0px" } : {}), "--verdict-gap": card.waiting > 0 ? "12px" : "4px" } as React.CSSProperties}
      >
        {ordinal != null && <span className={cn("col-start-1 tabular-nums", EASE, AT.num[mode], numberTone)} data-subject-ordinal>{ordinal}</span>}
        <p
          className={cn("col-start-2 m-0 font-normal [overflow-wrap:anywhere] [text-wrap:pretty]", EASE, AT.sentence[mode], sentenceTone)}
          role={onPick ? "button" : undefined}
          tabIndex={onPick ? 0 : undefined}
          aria-expanded={onPick ? !!selected : undefined}
          onKeyDown={pickKey}
          data-subject-sentence
        >
          <Sentence text={text} span={span} name={nameTone} />
        </p>
        <div className={cn(SLOT, AT.verdicts[mode])} {...LEDGER_STOP} data-subject-verdicts>{top}</div>

        {revisedNew && <p className="org-pop-in col-start-2 m-0 mt-1 text-[11px] leading-[18px] text-[color:var(--ink-violet)]">Revised since you last looked</p>}
        {looseNotes.map((note) => <FailNote key={note} note={note} className="col-start-2 mt-1.5" />)}

        {groups.map((group, i) => {
          const status = group.change?.status ?? card.status;
          const failed = split && group.change ? card.failed.find((f) => f.seq === group.change!.seq) : undefined;
          const ids = () => waiting((c) => c._id === group.change!._id || (group.change === firstWaiting && !drawn.has(c._id)));
          return (
            <React.Fragment key={group.key}>
              <div className={cn("col-start-2 min-w-0", i === 0 ? "mt-2" : "mt-[18px]")} data-subject-group={group.change?.seq ?? "all"}>
                {group.rows.length > 0 && (
                  <dl className="m-0 grid items-baseline gap-y-[2px]" style={{ gridTemplateColumns: `${gutter}px minmax(0, 1fr)` }}>
                    {group.rows.map((row, at) => <Field key={`${row.key}:${at}`} row={row} tone={groupTone(split ? status : state)} />)}
                  </dl>
                )}
                {failed && <FailNote note={failed.note} className="mt-1.5" />}
                {!settled && group.reasons.length > 0 && (
                  <div className={cn("mt-2 max-w-[70ch] space-y-1 text-[12px] leading-[1.6] [text-wrap:pretty]", EASE, state === "accepted" ? QUIET : MUTED)} data-subject-reasons>
                    {group.reasons.map((reason) => <p key={reason} className="m-0">{reason}</p>)}
                  </div>
                )}
              </div>
              {split && group.change && (
                <div className={cn(SLOT, AT.groupState[mode])} {...LEDGER_STOP} data-subject-group-state={group.change.status}>
                  {!isOrgChangeDecidable(group.change.status) ? <StateWord status={group.change.status} /> : onDecide ? verdicts(ids, group.change.status === "failed") : null}
                </div>
              )}
            </React.Fragment>
          );
        })}

        {!settled && card.depends.map((line) => <p key={line} className={cn("col-start-2 m-0 mt-1.5 text-[11px] leading-[18px]", QUIET)} data-subject-depends>{line}</p>)}
        {!settled && card.revisions.map((rev) => (
          <div key={rev.seq} className={cn("col-start-2 mt-1.5 text-[11px] leading-[18px]", revisedNew && "org-pop-in", QUIET)} data-revision={revisionKind(rev.seq)}>
            <span className={cn("font-semibold", MUTED)}>{rev.word}</span>{rev.note ? ` ${rev.note}` : ""}
            {rev.moves.length > 0 && (
              <span className="mt-0.5 block" data-revision-moves>
                {rev.moves.map((m) => <span key={m.key} className="block">{m.label}: {m.from !== null && <>was {m.from}, </>}now <span className={MUTED}>{m.to ?? "nothing"}</span></span>)}
              </span>
            )}
          </div>
        ))}

        {takeover && onDecide && card.waiting > 0 && <div className="col-start-2 mt-2" {...LEDGER_STOP}><TakeoverEdit phrase={takeover.phrase} leave={leave} onLeave={setLeave} /></div>}

        {foot && (
          <div className={cn("col-start-2 mt-[5px] flex min-w-0 flex-wrap items-baseline gap-x-3 text-[11px] leading-[18px]", QUIET)} {...LEDGER_STOP}>
            {!settled && sources.length > 0 && (
              <span className={cn("min-w-0", sourcesOpen && sources.length > 1 && "basis-full")} data-subject-sources={sources.length}>
                <button type="button" className={sourcesOpen ? undefined : LEDGER_LINK} aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((v) => !v)}>
                  {sourcesOpen ? (sources.length === 1 ? "Source:" : "Sources:") : `${sources.length} ${sources.length === 1 ? "source" : "sources"}`}
                </button>
                {sourcesOpen && sources.map((source, i) => {
                  const where = cn(sources.length > 1 ? "block" : "ml-[1ch]", MUTED);
                  if (!source.href) return <span key={i} className={where}>{source.label}</span>;
                  return /^https?:/i.test(source.href)
                    ? <a key={i} href={source.href} target="_blank" rel="noreferrer" className={cn(where, LEDGER_LINK)}>{source.label}</a>
                    : <Link key={i} href={source.href} className={cn(where, LEDGER_LINK)}>{source.label}</Link>;
                })}
              </span>
            )}
            {!settled && onEdit && card.waiting > 0 && <button type="button" className={LEDGER_LINK} onClick={onEdit} data-subject-edit>Edit</button>}
            {onAsk && <button type="button" className={LEDGER_LINK} onClick={onAsk} data-ask-about>Ask about this</button>}
          </div>
        )}
        {editor != null && <div className="order-last col-start-2 mt-2 min-w-0" {...LEDGER_STOP}>{editor}</div>}
      </div>
    </div>
  );
}
