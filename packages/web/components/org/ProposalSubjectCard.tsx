"use client";
// One entry of the proposal ledger (docs/architecture/org-staffing.md S39):
// every change a proposal makes to one goal, one project, one role or one
// record, read as a plain sentence, the fields it moves with what was there
// before, the reason, and the person's answer: Approve, Reject, or a reply in
// their own words. An answer fires nothing; it waits in the composer's batch
// ("on your next message") and one send applies the approvals and tells the
// agent, in words, what was rejected and what was said. The only boxes are
// things a person can press; the rest is type on hairlines, and colour
// appears only on a priority dot, a state word and the frame's one filled
// button.
//
// Callback driven: no store, no router, no chart. The conversation's card, the
// org page's panel, the company document and the chart's strip all hand it a
// `SubjectCard` from `proposalSubjects`, this card's pending `answer`, and
// `onAnswer` to put, replace or withdraw it.
import React, { useRef, useState, type ButtonHTMLAttributes } from "react";
import Link from "next/link";
import { AlertTriangle, Check, CheckSquare, Flag, FolderClosed, ListChecks, Sparkles } from "lucide-react";
import { isOrgChangeDecidable, ORG_REPLY_WORDS, type OrgChangeReply, type OrgChangeStatus, type OrgReplyVerdict } from "@codecast/shared/contracts/orgProposal";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useOverflows } from "../../hooks/useOverflows";
import { cn } from "../../lib/utils";
import { PRIORITY_META } from "../charter/charterMeta";
import { FIELD_SIZING_STYLE } from "../composerLayout";
import { KeyCap } from "../KeyCap";
import { Avatar } from "../tasks/TaskCommentStream";
import { OrgButton } from "./OrgButton";
import { RoleFace } from "./RoleFace";
import { TakeoverEdit } from "./TakeoverEdit";
import { CHIP_STATUS, GHOST } from "./orgMeta";
import type { OrgProposalChange } from "./orgStaffingTypes";
import { changeReply, subjectStatusWords, type FieldRow, type FieldValue, type SubjectCard } from "./proposalSubjects";
import type { ProposalTreeFace } from "./proposalTree";

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
/** A button that is a word: Reject, Reply, Chart. */
export const LEDGER_WORD = "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-normal leading-none no-underline text-[color:var(--sol-text-muted)] transition-colors [transition-duration:120ms] motion-reduce:transition-none hover:bg-[color-mix(in_srgb,var(--sol-border)_16%,transparent)] hover:text-[color:var(--sol-text)] disabled:cursor-not-allowed disabled:opacity-45";
/** The word button pressed: Reject, in its colour on a soft fill. */
export const WORD_PRESSED = "bg-[color-mix(in_srgb,var(--sol-red)_10%,transparent)] text-[color:var(--ink-red)] hover:bg-[color-mix(in_srgb,var(--sol-red)_16%,transparent)] hover:text-[color:var(--ink-red)]";

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
 * the frame's controls at the right (the one filled button among them once
 * there is something to send), or what happened in words once nothing
 * waits. `above` is a reply field or the saved words, on their own line over
 * the row. When it cannot fit one line the controls take the upper one.
 */
export function LedgerClosingRow({ left, right, above, outcome, sticky, className }: {
  left?: React.ReactNode;
  right?: React.ReactNode;
  above?: React.ReactNode;
  outcome?: React.ReactNode;
  /** Stay at the foot of a scrolling column, on the page's own ground. */
  sticky?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("not-prose border-t pt-3", LEDGER_INKS, sticky && "sticky bottom-0 bg-[var(--sol-bg)] pb-1", className)}
      style={{ borderColor: LEDGER_RULE }}
      {...LEDGER_STOP}
      data-ledger-close
    >
      {above != null && <div className="mb-2.5 min-w-0">{above}</div>}
      <div className="flex flex-wrap-reverse items-center gap-x-0.5 gap-y-1.5">
        {left != null && <div className="-ml-2 flex items-center gap-0.5">{left}</div>}
        <div className="ml-auto flex items-center gap-0.5">
          {right}
          {outcome != null && <span className={cn("text-[12px] leading-7", MUTED)} data-proposal-outcome>{outcome}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the answer

/** This card's pending answer, as the batch holds it. `leave_sessions` is
 *  the person's one edit on an approval that would take sessions over (R1):
 *  leave them where they are. */
export type SubjectAnswer = { verdict: OrgReplyVerdict; text?: string; leave_sessions?: boolean };

/** The test hooks a host puts on a shared piece (`data-subject-you`, `data-proposal-reply-field`). */
type DataHooks = { [hook: `data-${string}`]: string | boolean | undefined };

const FIELD_ASKS: Record<OrgReplyVerdict, string> = {
  reject: "Why not? Say what you want instead.",
  approve: "Say something about this change",
  note: "Say something about this change",
};

/**
 * The reply field: two rows of the ledger's type on a hairline box, growing
 * with the words. Every keystroke writes through `onChange` (the draft lives
 * in the batch, never here), so a fold, a scroll out of the list or a reload
 * loses nothing. Enter saves and closes, Shift+Enter is a new line, Esc or
 * leaving the field closes it and keeps what was saved. Keys never reach the
 * frame around it: a space would fold the card.
 */
export function LedgerReplyField({ value, ask, onChange, onClose, className, ...rest }: {
  value: string;
  /** The prompt in the empty field. */
  ask: string;
  onChange: (text: string) => void;
  onClose: () => void;
  className?: string;
} & DataHooks) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const grow = (el: HTMLTextAreaElement) => { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; };
  // Opened by a press: the caret goes to the end of what is already said.
  useMountEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    grow(el);
  });
  return (
    <div className={cn("min-w-0", className)} {...LEDGER_STOP} {...rest}>
      <textarea
        ref={ref}
        value={value}
        rows={2}
        placeholder={ask}
        aria-label={ask}
        className={cn("block w-full resize-none rounded-md border bg-transparent px-2.5 py-1.5 text-[12.5px] leading-[20px] outline-none placeholder:text-[color:var(--ink-quiet)] focus:border-[color-mix(in_srgb,var(--sol-violet)_60%,transparent)]", TEXT)}
        style={{ borderColor: LEDGER_RULE, ...FIELD_SIZING_STYLE }}
        onChange={(e) => { onChange(e.target.value); grow(e.target); }}
        onBlur={onClose}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onClose(); }
        }}
      />
      <div className={cn("mt-1 flex items-center gap-3 text-[11px] leading-[16px]", QUIET)}>
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">return</KeyCap> save</span>
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">shift</KeyCap><KeyCap size="xs">return</KeyCap> new line</span>
        <span className="inline-flex items-center gap-1"><KeyCap size="xs">esc</KeyCap> close</span>
      </div>
    </div>
  );
}

/** The person's own words under an entry: a quiet "You", then the words in
 *  full ink. With `onEdit`, a press opens them in the field. */
export function LedgerYou({ text, onEdit, className, ...rest }: { text: string; onEdit?: () => void; className?: string } & DataHooks) {
  const inner = <><span className={QUIET}>You: </span><span className={TEXT}>{text}</span></>;
  const look = cn("m-0 max-w-[70ch] whitespace-pre-line text-left text-[12.5px] leading-[1.55] [overflow-wrap:anywhere]", className);
  if (!onEdit) return <p className={look} {...rest}>{inner}</p>;
  return <button type="button" className={cn(look, "block rounded-sm hover:bg-[color-mix(in_srgb,var(--sol-border)_12%,transparent)]")} onClick={(e) => { e.stopPropagation(); onEdit(); }} onKeyDown={stop} onPointerDown={stop} title="Edit" {...rest}>{inner}</button>;
}

/** The pending answer in words, for a surface with no room for the card's
 *  pressed control and foot line (the chart's ghost strip): "Approved, on
 *  your next message", "Rejected: too soon", "Noted: who takes its work?". */
export function pendingAnswerWords(answer: SubjectAnswer): string {
  const text = answer.text?.trim();
  return `${ORG_REPLY_WORDS[answer.verdict].done}${text ? `: ${text}` : ", on your next message"}`;
}

/**
 * Whether the reply field is open, and the field itself. Open is the one
 * thing kept here: the words in it live in the batch (`answer.text`), so an
 * empty open field survives a withdrawn note and nothing else does. Closing
 * (Enter, Esc, a press elsewhere) keeps what was said; a note with nothing
 * said goes with it. Every surface that draws AnswerControls draws its field
 * from here, so Reply reads the same everywhere.
 */
export function useAnswerField(answer: SubjectAnswer | null | undefined, onAnswer: ((answer: SubjectAnswer | null) => void) | undefined, enabled = true) {
  const [fieldOpen, setFieldOpen] = useState(false);
  const open = fieldOpen && !!onAnswer && enabled;
  const close = () => { setFieldOpen(false); if (answer?.verdict === "note" && !answer.text?.trim()) onAnswer?.(null); };
  const field = (props: { className?: string } & DataHooks) => open && (
    <LedgerReplyField
      value={answer?.text ?? ""}
      ask={FIELD_ASKS[answer?.verdict ?? "note"]}
      onChange={(t) => onAnswer?.({ ...answer, verdict: answer?.verdict ?? "note", text: t })}
      onClose={close}
      data-subject-reply-field={answer?.verdict ?? "note"}
      {...props}
    />
  );
  return { open, setOpen: setFieldOpen, field };
}

/** The three answers on a card that waits. Approve is the quiet outline (the
 *  filled lead on a card that stands alone), pressed while it is the answer;
 *  pressed again it withdraws. Reject presses the same way and opens the
 *  field; Reply opens it with the verdict as it stands. */
export function AnswerControls({ answer, retry, filled, dense, onAnswer, onOpen, open }: {
  answer: SubjectAnswer | null | undefined;
  retry: boolean;
  filled?: boolean;
  /** Tighter words, for a strip that must fit a chart card. */
  dense?: boolean;
  onAnswer: (answer: SubjectAnswer | null) => void;
  /** Open or close the reply field. */
  onOpen: (open: boolean) => void;
  open: boolean;
}) {
  const tight = dense ? "px-1.5 text-[11px]" : undefined;
  const verdict = answer?.verdict;
  const toggle = (v: OrgReplyVerdict) => {
    if (verdict === v) { onAnswer(null); onOpen(false); return; }
    onAnswer({ verdict: v, ...(answer?.text ? { text: answer.text } : {}) });
    onOpen(v === "reject");
  };
  // One filled button per frame: only a card that stands alone fills its Approve, and only until it is pressed.
  const fill = !!filled && !retry && verdict !== "approve";
  return (
    <>
      <OrgButton size="sm" quiet={!fill} primary={fill} className={tight} aria-pressed={verdict === "approve"} onClick={() => toggle("approve")} data-subject-approve>
        {verdict === "approve" && <Check className="-ml-0.5 h-3 w-3" aria-hidden />}
        {retry ? "Retry" : ORG_REPLY_WORDS.approve.act}
      </OrgButton>
      <LedgerWord className={cn(tight, verdict === "reject" && WORD_PRESSED)} aria-pressed={verdict === "reject"} onClick={() => toggle("reject")} data-subject-reject>{ORG_REPLY_WORDS.reject.act}</LedgerWord>
      <LedgerWord className={cn(tight, !dense && "-mr-2")} aria-expanded={open} onClick={() => onOpen(!open)} data-subject-reply>{ORG_REPLY_WORDS.note.act}</LedgerWord>
    </>
  );
}

// ---------------------------------------------------------------- values

/** A value as the words a person reads. */
export function fieldValueText(value: FieldValue): string {
  switch (value.kind) {
    case "text": return value.text + (value.tail ?? "");
    case "none": return value.text;
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

/** The rows a goal or a project writes at length. Read in full on the
 *  purpose's card; two lines with a quiet "more" everywhere else. */
const LONG_ROWS = new Set(["says", "why", "done_when"]);

/** Words at length: two lines, then a quiet "more" that opens them, shown
 *  only when the words do not fit. "less" folds them again. */
function Clamped({ text, tail, struck }: { text: string; tail?: string; struck: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  // Two lines of 20px; a pixel of slack for rounding.
  const clipped = useOverflows(ref, 41, [text, tail]);
  return (
    <span className="block min-w-0" data-field-clamp={open ? "open" : "closed"}>
      <span ref={ref} className={cn("block", !open && "line-clamp-2", struck && STRUCK)}>{text}{tail && <span className={QUIET}>{tail}</span>}</span>
      {(clipped || open) && (
        <button type="button" className={cn(LEDGER_LINK, QUIET, "text-[11px] leading-[16px]")} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} onKeyDown={stop} onPointerDown={stop} data-field-more>{open ? "less" : "more"}</button>
      )}
    </span>
  );
}

/** One value. `was`: the side being left, drawn plainer (a priority without
 *  its dot). `struck`: a real value that goes away; its face is never struck.
 *  `clamp`: words at length fold to two lines. A person is always named:
 *  the sentence says "you", the field says who. */
function Value({ value, was, struck = false, clamp = false }: { value: FieldValue; was?: boolean; struck?: boolean; clamp?: boolean }) {
  switch (value.kind) {
    case "none": return <span className={QUIET}>{value.text}</span>;
    case "text": return clamp
      ? <Clamped text={value.text} tail={value.tail} struck={struck} />
      : <span className={struck ? STRUCK : undefined}>{value.text}{value.tail && <span className={QUIET}>{value.tail}</span>}</span>;
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
 *  not, the after drops to its own line behind the arrow. `short`: the long
 *  rows fold to two lines. */
function Field({ row, tone, short }: { row: FieldRow; tone: string; short: boolean }) {
  const { before, after, op } = row;
  const clamp = short && LONG_ROWS.has(row.key);
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
        {shown && <span className={cn("min-w-0 max-w-full", QUIET)}><Value value={shown} was struck={gone} clamp={clamp} /></span>}
        {after && (shown ? (
          <span className="flex min-w-0 max-w-full gap-x-[1ch]">
            <span aria-hidden className={cn("flex-none font-medium", MUTED)}>→</span>
            <span className="sr-only">becomes</span>
            <span className="min-w-0"><Value value={after} clamp={clamp} /></span>
          </span>
        ) : (
          <span className={cn("min-w-0 max-w-full", taken && QUIET)}><Value value={after} was={taken} struck={taken} clamp={clamp} /></span>
        ))}
        {same && <span className={QUIET}>no change</span>}
      </dd>
    </>
  );
}

// ---------------------------------------------------------------- verdicts and state

/** Where a decided entry stands, in a word. "Approved" in cyan while the
 *  approval lands, green once it did; "Rejected" quiet. The word stays
 *  mounted so the colour settles. */
function StateWord({ status }: { status: OrgChangeStatus | SubjectCard["status"] }) {
  if (status !== "accepted" && status !== "applied" && status !== "skipped") return null;
  const ink = status === "accepted" ? "text-[color:var(--ink-cyan)]" : status === "applied" ? "text-[color:var(--ink-green)]" : QUIET;
  return <span className={cn("org-pop-in text-[12px] leading-[21px] transition-colors [transition-duration:400ms] motion-reduce:transition-none", ink)} data-subject-state={status}>{status === "skipped" ? ORG_REPLY_WORDS.reject.done : ORG_REPLY_WORDS.approve.done}</span>;
}

/** Under an entry once the send went: "Noted, waiting for a revision" on a
 *  card the person wrote back on, which the agent has yet to amend. */
function NotedLine({ className }: { className?: string }) {
  return <p className={cn("m-0 text-[11px] leading-[18px]", QUIET, className)} data-subject-noted>{ORG_REPLY_WORDS.note.done}, waiting for a revision</p>;
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

// Wide (over 560px of card): number, reading column, verdict gutter (196px:
// Approve, Reject and Reply on one line). Narrow: number and reading column,
// with the answers in a right aligned row under the entry. With no layout
// given the card asks its own width. Tailwind reads these strings whole, so
// each form is written out.
const AT = {
  grid: {
    narrow: "[--num:20px] grid-cols-[var(--num)_minmax(0,1fr)]",
    wide: "[--num:28px] grid-cols-[var(--num)_minmax(0,1fr)_196px]",
    auto: "[--num:20px] grid-cols-[var(--num)_minmax(0,1fr)] [@container_(min-width:561px)]:[--num:28px] [@container_(min-width:561px)]:grid-cols-[var(--num)_minmax(0,1fr)_196px]",
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
  // "on your next message": the gutter's foot in the wide form, under the answer row in the narrow one.
  pending: {
    narrow: "col-start-2 order-last mt-1 justify-self-end",
    wide: "col-start-3 self-end justify-self-end",
    auto: "col-start-2 order-last mt-1 justify-self-end [@container_(min-width:561px)]:order-none [@container_(min-width:561px)]:col-start-3 [@container_(min-width:561px)]:mt-0 [@container_(min-width:561px)]:self-end",
  },
} as const;
const SLOT = "flex h-[21px] items-center justify-self-end gap-0.5 whitespace-nowrap";

// ---------------------------------------------------------------- the entry

export type ProposalSubjectCardProps = {
  card: SubjectCard;
  /** "full": the sentence, the fields, the reasons, the answers. "row": one line (face, sentence, state, Approve and Reject) for a long fold; it opens on pick. */
  variant?: "full" | "row";
  /** The card's place in its list, from 1: the number column. Absent on a card that stands alone, which then draws no rule and no padding of its own. */
  ordinal?: number;
  /** Where the answers sit. Absent: the card asks its own width (wide over 560px). */
  layout?: "wide" | "narrow";
  /** A card that stands alone in its frame: its Approve is the frame's one filled button, until pressed. */
  lead?: boolean;
  /** A card that stands alone: the line above the sentence ("First of nine in <the proposal>"). */
  place?: React.ReactNode;
  /** This card's pending answer, from the batch. */
  answer?: SubjectAnswer | null;
  /** Put, replace (same verdict, new words) or withdraw (null) this card's answer. Absent: read only. */
  onAnswer?: (answer: SubjectAnswer | null) => void;
  /** "Edit", in the entry's foot line; shown only when set, and only while the card waits. */
  onEdit?: () => void;
  /** The host's edit form, under the entry. */
  editor?: React.ReactNode;
  /** What approving would take over (R1): the phrase, and the "leave them" box, whose tick rides on the approval as `leave_sessions`. */
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
      const own = change.rationale?.trim().toLowerCase() ?? "";
      const reasons = card.reasons.filter((r) => unclaimed.has(r) && own === r.toLowerCase());
      for (const r of reasons) unclaimed.delete(r);
      return { key: change._id, change, rows: card.rows.filter((r) => r.seq === change.seq), reasons };
    })
    .filter((g) => split || g.rows.length > 0 || g.reasons.length > 0);
}

export function ProposalSubjectCard({ card, variant = "full", ordinal, layout, lead, place, answer, onAnswer, onEdit, editor, takeover, selected, onPick, revisedNew, sentence = "named", className }: ProposalSubjectCardProps) {
  // "Leave the sessions where they are": the tick is read from the pending
  // approval once there is one, and kept here only until there is.
  const [leaveLocal, setLeaveLocal] = useState(false);
  const leave = answer?.leave_sessions ?? leaveLocal;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // An entry decided in this view keeps its height, so nothing jumps under the
  // pointer while someone answers down the list. It folds to its sentence the
  // next time it mounts.
  const decidedAtMount = useRef(card.status === "applied" || card.status === "skipped").current;
  const settled = decidedAtMount && (card.status === "applied" || card.status === "skipped");

  const members = [...card.changes, ...card.carried, ...card.riders];
  // Its changes ended differently: each group then says where it stands.
  const split = card.status === "mixed" || (card.status === "failed" && card.failed.length < members.length);
  const state = split ? "mixed" : card.status;
  // Every write to the batch goes through here: an approval carries the tick when it is set.
  const put = (a: SubjectAnswer | null) => onAnswer?.(a && a.verdict === "approve" && leave ? { ...a, leave_sessions: true } : a);
  const { open, setOpen: setFieldOpen, field: replyField } = useAnswerField(answer, onAnswer && put, card.waiting > 0);
  const onLeave = (v: boolean) => { setLeaveLocal(v); if (answer?.verdict === "approve") onAnswer?.(v ? { ...answer, leave_sessions: true } : { verdict: answer.verdict, ...(answer.text ? { text: answer.text } : {}) }); };
  const controls = (retry: boolean, filled?: boolean) => <AnswerControls answer={answer} retry={retry} filled={filled} onAnswer={put} open={open} onOpen={setFieldOpen} />;
  const words = <span className={cn("text-[12px] leading-[21px]", MUTED)} data-subject-state={state}>{subjectStatusWords(card)}</span>;
  // The stored answer the row still carries (a rejection's words, a note), once the send went.
  const stored = (change: OrgProposalChange | null) => (change ? changeReply(change) : card.reply);
  const noted = (reply: OrgChangeReply | null, status: OrgChangeStatus | SubjectCard["status"]) => reply?.verdict === "note" && isOrgChangeDecidable(status as OrgChangeStatus);
  const pendingText = answer?.text?.trim() ? answer.text : null;
  const youOf = (change: OrgProposalChange | null) => {
    const reply = stored(change);
    // The pending words lead while they exist; the field, when open, is where they show.
    if (pendingText) return open ? null : <LedgerYou text={pendingText} onEdit={() => setFieldOpen(true)} className="mt-1.5" data-subject-you={answer!.verdict} />;
    if (reply?.text?.trim()) return <LedgerYou text={reply.text} onEdit={onAnswer && card.waiting > 0 ? () => setFieldOpen(true) : undefined} className="mt-1.5" data-subject-you={reply.verdict} />;
    return null;
  };

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
    "data-subject-answer": answer?.verdict,
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
          {card.waiting === 0 ? (split ? words : <StateWord status={card.status} />) : !onAnswer ? words : (
            <>
              {split && words}
              {/* The one line form has no room for a field: Reply opens the card. */}
              <AnswerControls answer={answer} retry={card.failed.length > 0} onAnswer={put} open={false} onOpen={(want) => { if (want) onPick?.(); }} />
            </>
          )}
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
    ? card.waiting === 0 ? <StateWord status={card.status} /> : onAnswer ? controls(card.status === "failed", lead) : words
    : words;
  const revisionKind = (seq: number) => card.changes.find((c) => c.seq === seq)?.revision?.kind;
  const sources = card.evidence;
  const foot = !settled && (sources.length > 0 || (onEdit && card.waiting > 0));
  const field = replyField({ className: "mt-2" });

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
          const reply = split ? stored(group.change) : null;
          return (
            <React.Fragment key={group.key}>
              <div className={cn("col-start-2 min-w-0", i === 0 ? "mt-2" : "mt-[18px]")} data-subject-group={group.change?.seq ?? "all"}>
                {group.rows.length > 0 && (
                  <dl className="m-0 grid items-baseline gap-y-[2px]" style={{ gridTemplateColumns: `${gutter}px minmax(0, 1fr)` }}>
                    {group.rows.map((row, at) => <Field key={`${row.key}:${at}`} row={row} tone={groupTone(split ? status : state)} short={!card.purpose} />)}
                  </dl>
                )}
                {failed && <FailNote note={failed.note} className="mt-1.5" />}
                {!settled && group.reasons.length > 0 && (
                  <div className={cn("mt-2 max-w-[70ch] space-y-1 text-[12px] leading-[1.6] [text-wrap:pretty]", EASE, state === "accepted" ? QUIET : MUTED)} data-subject-reasons>
                    {group.reasons.map((reason) => <p key={reason} className="m-0">{reason}</p>)}
                  </div>
                )}
                {/* On a card whose changes ended differently each group carries the words said about it. */}
                {split && group.change && (
                  <>
                    {reply?.text?.trim() && <LedgerYou text={reply.text} className="mt-1.5" data-subject-you={reply.verdict} />}
                    {noted(reply, status) && <NotedLine className="mt-1" />}
                  </>
                )}
              </div>
              {split && group.change && (
                <div className={cn(SLOT, AT.groupState[mode])} {...LEDGER_STOP} data-subject-group-state={group.change.status}>
                  {!isOrgChangeDecidable(group.change.status) ? <StateWord status={group.change.status} /> : onAnswer ? controls(group.change.status === "failed") : null}
                </div>
              )}
            </React.Fragment>
          );
        })}

        {/* The person's words on the card, pending or stored, then the field while it is open. */}
        {!split && (() => { const you = youOf(null); return you && <div className="col-start-2 min-w-0">{you}</div>; })()}
        {!split && !pendingText && noted(card.reply, card.status) && <NotedLine className="col-start-2 mt-1" />}
        {field && <div className="col-start-2 min-w-0">{field}</div>}

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

        {takeover && onAnswer && card.waiting > 0 && <div className="col-start-2 mt-2" {...LEDGER_STOP}><TakeoverEdit phrase={takeover.phrase} leave={leave} onLeave={onLeave} /></div>}

        {foot && (
          <div className={cn("col-start-2 mt-[5px] flex min-w-0 flex-wrap items-baseline gap-x-3 text-[11px] leading-[18px]", QUIET)} {...LEDGER_STOP}>
            {sources.length > 0 && (
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
            {onEdit && card.waiting > 0 && <button type="button" className={LEDGER_LINK} onClick={onEdit} data-subject-edit>Edit</button>}
          </div>
        )}
        {/* A pending card never looks decided: the one mark beyond the pressed control is this line at the gutter's foot. */}
        {answer && onAnswer && card.waiting > 0 && <span className={cn("whitespace-nowrap text-[11px] leading-[18px]", QUIET, AT.pending[mode])} data-subject-pending>on your next message</span>}
        {editor != null && <div className="order-last col-start-2 mt-2 min-w-0" {...LEDGER_STOP}>{editor}</div>}
      </div>
    </div>
  );
}
