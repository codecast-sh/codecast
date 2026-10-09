"use client";
// One entry of the proposal ledger (docs/architecture/org-staffing.md S39):
// every change a proposal makes to one goal, one project, one role or one
// record, read as a plain sentence, the fields it moves with what was there
// before, the reason, and the person's answer: Approve, Reject, or a reply in
// their own words. An answer fires nothing: the controls give way to a band
// that says what the send will do, and the composer's send applies the
// approvals and tells the agent, in words, what was rejected and what was
// said. The only boxes are things a person can press; the rest is type on
// hairlines, and colour appears only on a priority dot, a state word, the
// band's wash and the frame's one filled button.
//
// Callback driven: no store, no router. The ledger hands it a `SubjectCard`
// from `proposalSubjects`, this card's pending `answer`, `onAnswer` to put,
// replace or withdraw it, and `focused` from the store's orgFocusChangeId.
import React, { useRef, useState, type ButtonHTMLAttributes } from "react";
import Link from "next/link";
import { AlertTriangle, Check, CheckSquare, Flag, FolderClosed, ListChecks, Sparkles } from "lucide-react";
import { passageDiff, type ChangeField, type PassagePart } from "@codecast/shared/contracts/orgChangeWords";
import { isOrgChangeDecidable, ORG_REPLY_WORDS, type OrgChangeReply, type OrgChangeStatus, type OrgReplyVerdict } from "@codecast/shared/contracts/orgProposal";
import { useMountEffect } from "../../hooks/useMountEffect";
import { EntityIdPill } from "../EntityIdPill";
import { TASK_STATUS, type TaskStatus } from "../TaskStatusBadge";
import { PLAN_STATUS_CONFIG } from "../../lib/planStatus";
import { PROJECT_STATUS, type ProjectStatus } from "../../lib/projectStatus";
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
import { useOrgHover } from "./proposalContexts";
import { lightChanges, useChangeLit } from "./lines/changeLight";
import { changeReply, fieldText, subjectStatusWords, type SubjectCard, type SubjectStatus } from "./proposalSubjects";
import type { ProposalTreeFace } from "./proposalTree";
import { StagedBand, stagedWash } from "./StagedBand";
import { useWatchEffect } from "../../hooks/useWatchEffect";

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
/** A button that is a word: Reject, Reply, Map. */
export const LEDGER_WORD = "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12.5px] font-normal leading-none no-underline text-[color:var(--sol-text-muted)] transition-colors [transition-duration:120ms] motion-reduce:transition-none hover:bg-[color-mix(in_srgb,var(--sol-border)_16%,transparent)] hover:text-[color:var(--sol-text)] disabled:cursor-not-allowed disabled:opacity-45";
/** The word button pressed: Reject, in its colour on a soft fill. */
export const WORD_PRESSED = "bg-[color-mix(in_srgb,var(--sol-red)_10%,transparent)] text-[color:var(--ink-red)] hover:bg-[color-mix(in_srgb,var(--sol-red)_16%,transparent)] hover:text-[color:var(--ink-red)]";

const TEXT = "text-[color:var(--sol-text)]";
const SOFT = "text-[color:var(--sol-text-secondary)]";
const MUTED = "text-[color:var(--sol-text-muted)]";
const QUIET = "text-[color:var(--ink-quiet)]";
const RED = "text-[color:var(--ink-red)]";
const STRUCK = "line-through decoration-1";
const EASE = "transition-colors duration-200 motion-reduce:transition-none";
/** The three sizes of this area: sentences and titles, values, labels. */
const SENTENCE = "text-[13.5px] leading-[20px]";
const VALUE = "text-[12.5px] leading-[20px]";
const LABEL = "text-[11px] leading-[20px]";

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
/** A control's press, key or pointer never reaches the frame around it (a card that opens on a click). */
export const LEDGER_STOP = { onClick: stop, onKeyDown: stop, onPointerDown: stop } as const;

export function LedgerWord({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cn(LEDGER_WORD, className)} {...rest} />;
}

/**
 * The ledger's closing line, under a stronger rule: word buttons at the left,
 * the frame's controls at the right, or what happened in words once nothing
 * waits. `above` is a line over the row. When it cannot fit one line the
 * controls take the upper one.
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
          {outcome != null && <span className={cn("text-[12.5px] leading-7", MUTED)} data-proposal-outcome>{outcome}</span>}
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

export const FIELD_ASKS: Record<OrgReplyVerdict, string> = {
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

/**
 * Whether the reply field is open, and the field itself. Open is the one
 * thing kept here: the words in it live in the batch (`answer.text`), so an
 * empty open field survives a withdrawn note and nothing else does. Closing
 * (Enter, Esc, a press elsewhere) keeps what was said; a note with nothing
 * said goes with it. Every surface that draws AnswerControls draws its field
 * from here, so Reply reads the same everywhere; `asks` rewords the prompt
 * for a surface that is not one change (a group of records).
 */
export function useAnswerField(answer: SubjectAnswer | null | undefined, onAnswer: ((answer: SubjectAnswer | null) => void) | undefined, enabled = true, asks: Partial<Record<OrgReplyVerdict, string>> = {}) {
  const [fieldOpen, setFieldOpen] = useState(false);
  const open = fieldOpen && !!onAnswer && enabled;
  const close = () => { setFieldOpen(false); if (answer?.verdict === "note" && !answer.text?.trim()) onAnswer?.(null); };
  const field = (props: { className?: string } & DataHooks) => open && (
    <LedgerReplyField
      value={answer?.text ?? ""}
      ask={asks[answer?.verdict ?? "note"] ?? FIELD_ASKS[answer?.verdict ?? "note"]}
      onChange={(t) => onAnswer?.({ ...answer, verdict: answer?.verdict ?? "note", text: t })}
      onClose={close}
      data-subject-reply-field={answer?.verdict ?? "note"}
      {...props}
    />
  );
  return { open, setOpen: setFieldOpen, field };
}

/** The three answers on an entry that waits. Approve is the quiet outline
 *  (the filled lead on a card that stands alone). Reject opens the field;
 *  Reply opens it with the verdict as it stands. */
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
      <OrgButton size="sm" quiet={!fill} primary={fill} className={tight} aria-pressed={verdict === "approve"} onClick={() => toggle("approve")} title={retry ? "Add a retry to your reply. It runs again when you send it." : "Add your approval to your reply. Nothing changes until you send it."} data-subject-approve>
        {verdict === "approve" && <Check className="-ml-0.5 h-3 w-3" aria-hidden />}
        {retry ? "Retry" : ORG_REPLY_WORDS.approve.act}
      </OrgButton>
      <LedgerWord className={cn(tight, verdict === "reject" && WORD_PRESSED)} aria-pressed={verdict === "reject"} onClick={() => toggle("reject")} title="Add a rejection to your reply. It goes out when you send it." data-subject-reject>{ORG_REPLY_WORDS.reject.act}</LedgerWord>
      <LedgerWord className={cn(tight, !dense && "-mr-2")} aria-expanded={open} onClick={() => onOpen(!open)} title="Add a note to your reply. It goes out when you send it." data-subject-reply>{ORG_REPLY_WORDS.note.act}</LedgerWord>
    </>
  );
}

// ---------------------------------------------------------------- values

/** A face at the height of a line of ledger type. A person's avatar has one
 *  drawn size, so it is scaled into the same box as the rest. */
function SmallFace({ face }: { face: ProposalTreeFace | undefined }) {
  // A face nobody could name draws no mark: the name stands alone.
  if (!face || face.kind === "unknown") return null;
  return (
    <span className="relative -top-px mr-1.5 inline-flex h-[15px] w-[15px] items-center justify-center align-middle" data-subject-face={face.kind}>
      {face.kind === "person" ? <span className="inline-flex shrink-0 scale-[0.6]"><Face face={face} /></span> : <Face face={face} size={15} />}
    </span>
  );
}

const CLAMP_LINE = 20;
const LINE_CLAMP = { 2: "line-clamp-2", 4: "line-clamp-4" } as const;

/** The word that opens a clamp: "show all" until pressed, "show less" after. */
function ClampWord({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={cn(LEDGER_LINK, QUIET, "block text-[11px] leading-[16px]")} aria-expanded={open} onClick={(e) => { e.stopPropagation(); onToggle(); }} onKeyDown={stop} onPointerDown={stop} data-field-more>
      {open ? "show less" : "show all"}
    </button>
  );
}

/** Words at length: `lines` of them, then "show all" on its own line under
 *  the text, drawn only when the words do not fit. Never on a sentence. */
export function Clamp({ lines = 2, children, tail, struck, className }: { lines?: 2 | 4; children: string; tail?: string; struck?: boolean; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const clipped = useOverflows(ref, lines * CLAMP_LINE + 1, [children, tail]);
  return (
    <span className={cn("block min-w-0", className)} data-field-clamp={open ? "open" : "closed"}>
      <span ref={ref} className={cn("block whitespace-pre-line", !open && LINE_CLAMP[lines], struck && STRUCK)}>{children}{tail && <span className={QUIET}>{tail}</span>}</span>
      {(clipped || open) && <ClampWord open={open} onToggle={() => setOpen((v) => !v)} />}
    </span>
  );
}

/** What changed in a passage, inline and in reading order: the unchanged
 *  sentences quiet, a run of them folded to an ellipsis, what goes struck on
 *  a red wash, what comes on a green one. Never two columns, never two full
 *  texts. Past four lines it clamps like any long value. */
export function PassageDiff({ parts, className }: { parts: readonly PassagePart[]; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const clipped = useOverflows(ref, 4 * 20 + 1, [parts]);
  const changed = parts.filter((p) => p.kind === "added" || p.kind === "removed").length;
  return (
    <span className={cn("block min-w-0", className)} data-field-clamp={open ? "open" : "closed"}>
      <p ref={ref} className={cn("m-0 max-w-[70ch] text-[12.5px] leading-[1.6] whitespace-pre-line [overflow-wrap:anywhere]", !open && "line-clamp-4")} data-passage-diff={changed}>
        {parts.map((part, i) => {
          if (part.kind === "same") return <span key={i} className={SOFT} data-diff="same">{part.text}</span>;
          if (part.kind === "gap") return <span key={i} className={cn(QUIET, "mx-[2px]")} title="unchanged" data-diff="gap">{"…"} </span>;
          if (part.kind === "removed") return <del key={i} className={cn("rounded-[3px] bg-[color-mix(in_srgb,var(--sol-red)_12%,transparent)] px-[2px] line-through decoration-1", RED)} data-diff="removed">{part.text}</del>;
          return <ins key={i} className={cn("rounded-[3px] bg-[color-mix(in_srgb,var(--sol-green)_14%,transparent)] px-[2px] no-underline", TEXT)} data-diff="added">{part.text}</ins>;
        })}
      </p>
      {(clipped || open) && <ClampWord open={open} onToggle={() => setOpen((v) => !v)} />}
    </span>
  );
}

/** Two texts that would each clamp: shorter as one diff than as two folds. */
const LONG_TEXT = 140;

type Side = "before" | "after";
type FaceOf = (side: Side) => ProposalTreeFace | undefined;

/** One value. `was`: the side being left, drawn plainer (a priority without
 *  its dot). `struck`: a real value that goes away; its face is never struck.
 *  `clamp`: words at length fold to two lines. */
function Value({ field, side, face, struck = false, clamp = true }: { field: ChangeField; side: Side; face: FaceOf; struck?: boolean; clamp?: boolean }) {
  const v = field[side];
  if (!v) return null;
  if (v.none) return <span className={QUIET}>{v.text}</span>;
  const was = side === "before";
  switch (field.kind) {
    case "priority": {
      const meta = v.priority ? PRIORITY_META[v.priority] : null;
      if (was || !meta) return <span className={struck ? STRUCK : undefined}>{v.text}</span>;
      return <span className="inline-flex items-center gap-1.5 font-semibold"><i aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} />{v.text}</span>;
    }
    case "measures": return (
      <>
        {(v.measures ?? []).map((m, i) => (
          // One measure per line; a line that wraps hangs. The target is the author's words, never parsed.
          <span key={i} className={cn("block pl-[2ch] [text-indent:-2ch]", struck && STRUCK)}>{m.name}{m.target && <><span className={QUIET}>, target </span>{m.target}</>}</span>
        ))}
      </>
    );
    case "ref": return <span><SmallFace face={face(side)} /><span className={struck ? STRUCK : undefined}>{v.text}</span></span>;
    case "list": return <span className={struck ? STRUCK : undefined}>{v.items?.join(", ") ?? v.text}</span>;
    default: return clamp
      ? <Clamp tail={v.tail} struck={struck}>{v.text}</Clamp>
      : <span className={struck ? STRUCK : undefined}>{v.text}{v.tail && <span className={QUIET}>{v.tail}</span>}</span>;
  }
}

/** The kind of record a status field moves, which picks its vocabulary. */
export type RecordKind = "task" | "plan" | "project";

/** A record's status as the record's own pages draw it: glyph, word, colour. Null for a word none of them knows. */
function statusLook(record: RecordKind | undefined, words: string) {
  const key = words.trim().replace(/ /g, "_");
  const look = record === "plan" ? PLAN_STATUS_CONFIG[key] : record === "project" ? PROJECT_STATUS[key as ProjectStatus] : TASK_STATUS[key as TaskStatus];
  return look ? { Icon: look.icon, label: look.label, color: look.color } : null;
}

/** A status that moves, the thing a person approves: what it leaves struck
 *  on a red wash, what it becomes on a green one, each with the record's own
 *  status glyph, at the size of the sentence. */
function StatusMove({ field, record }: { field: ChangeField; record?: RecordKind }) {
  const was = field.before && !field.before.none ? statusLook(record, field.before.text) : null;
  const now = field.after && !field.after.none ? statusLook(record, field.after.text) : null;
  if (!now) return null;
  const chip = "inline-flex items-center gap-1.5 rounded-md px-2 py-[2px] text-[13.5px] leading-[22px] no-underline";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-status-move>
      {was && (
        <>
          <del className={cn(chip, "bg-[color-mix(in_srgb,var(--sol-red)_12%,transparent)]", RED)} data-diff="removed">
            <was.Icon className={cn("h-3.5 w-3.5 shrink-0 opacity-70", was.color)} />
            <span className={STRUCK}>{was.label}</span>
          </del>
          <span aria-hidden className={cn("font-medium", MUTED)}>→</span>
          <span className="sr-only">becomes</span>
        </>
      )}
      <ins className={cn(chip, "bg-[color-mix(in_srgb,var(--sol-green)_16%,transparent)] font-semibold text-[color:var(--ink-green)]")} data-diff="added">
        <now.Icon className={cn("h-3.5 w-3.5 shrink-0", now.color)} />
        {now.label}
      </ins>
    </span>
  );
}

/** A list that gains entries: the kept names, then the new ones behind a quiet plus. */
function Added({ field }: { field: ChangeField }) {
  const before = new Set((field.before?.items ?? []).map((x) => x.toLowerCase()));
  const kept = (field.after?.items ?? []).filter((x) => before.has(x.toLowerCase()));
  const added = (field.after?.items ?? []).filter((x) => !before.has(x.toLowerCase()));
  return <span>{kept.join(", ")}{kept.length > 0 && added.length > 0 && " "}{added.length > 0 && <span className={QUIET}>+ {added.join(", ")}</span>}</span>;
}

/** One field: its label, then the value, or what was there, an arrow, and
 *  what it becomes. Before and after share a line when they fit; when they do
 *  not, the after drops to its own line behind the arrow. A field whose
 *  before equals its after (op same) is never drawn. */
export function Field({ field, face = () => undefined, tone = TEXT, clamp = true, label = field.label, record }: { field: ChangeField; face?: FaceOf; tone?: string; clamp?: boolean; label?: string; record?: RecordKind }) {
  const { before, after, op, kind } = field;
  const long = kind === "text" && op === "change" && !!before && !!after && !before.none && !after.none && before.text.length > LONG_TEXT && after.text.length > LONG_TEXT;
  const passage = kind === "passage" ? field.diff ?? [] : long ? passageDiff(before!.text, after!.text) : null;
  // Replaced or cleared: the old value is struck. A list that only gains or loses entries keeps the rest, so it is not.
  const gone = !!before && !before.none && (op === "change" || op === "clear");
  // Entries a change takes away, with no list in hand to compare.
  const taken = op === "remove" && !before;
  const move = kind === "status" && !!after && !after.none && !!statusLook(record, after.text);
  return (
    <>
      <dt className={cn("m-0 whitespace-nowrap font-normal", LABEL, QUIET)}>{label}</dt>
      <dd
        className={cn("m-0 flex min-w-0 flex-wrap gap-x-[1ch] [overflow-wrap:anywhere]", VALUE, EASE, tone)}
        data-field={field.key}
        data-field-op={op}
        data-field-before={fieldText(before)}
        data-field-after={fieldText(after)}
      >
        {move ? <StatusMove field={field} record={record} /> : passage ? <PassageDiff parts={passage} /> : kind === "list" && op === "add" ? <Added field={field} /> : (
          <>
            {before && <span className={cn("min-w-0 max-w-full", QUIET)}><Value field={field} side="before" face={face} struck={gone} clamp={clamp} /></span>}
            {after && (before ? (
              <span className="flex min-w-0 max-w-full gap-x-[1ch]">
                <span aria-hidden className={cn("flex-none font-medium", MUTED)}>→</span>
                <span className="sr-only">becomes</span>
                <span className="min-w-0"><Value field={field} side="after" face={face} clamp={clamp} /></span>
              </span>
            ) : (
              <span className={cn("min-w-0 max-w-full", taken && QUIET)}><Value field={field} side="after" face={face} struck={taken} clamp={clamp} /></span>
            ))}
          </>
        )}
      </dd>
    </>
  );
}

/** The fields of one change as a definition list; a run of charter passages shares one label. */
function Fields({ fields, faces, tone, clamp, record, className }: { fields: readonly ChangeField[]; faces: SubjectCard["faces"]; tone: string; clamp: boolean; record?: RecordKind; className?: string }) {
  const drawn = fields.filter((f) => f.op !== "same");
  if (!drawn.length) return null;
  // The label gutter fits the longest label ("Measured by"), and widens for a card that carries a longer one.
  const gutter = Math.max(86, Math.ceil(Math.max(0, ...drawn.map((f) => f.label.length)) * 6.7) + 6);
  return (
    <dl className={cn("m-0 grid items-baseline gap-y-[2px]", className)} style={{ gridTemplateColumns: `${gutter}px minmax(0, 1fr)` }}>
      {drawn.map((f, i) => {
        const prev = drawn[i - 1];
        const shared = f.kind === "passage" && prev?.kind === "passage" && prev.label === f.label && prev.seq === f.seq;
        return <Field key={`${f.seq}:${f.key}:${i}`} field={f} face={(side) => faces[`${f.seq}:${f.key}:${side}`]} tone={tone} clamp={clamp} label={shared ? "" : f.label} record={record} />;
      })}
    </dl>
  );
}

// ---------------------------------------------------------------- verdicts and state

const STATE_WORDS: Partial<Record<SubjectStatus | OrgChangeStatus, [string, string]>> = {
  accepted: ["Approved, applying", "text-[color:var(--ink-cyan)]"],
  applied: ["Applied", "text-[color:var(--ink-green)]"],
  skipped: ["Rejected", QUIET],
  mixed: ["", MUTED],
};

/** Where a decided entry stands, in a word: "Approved, applying" in cyan
 *  while the approval lands, "Applied" in green once it did, "Rejected"
 *  quiet. `words` replaces the word for a group ("Applying 10 of 18", "12
 *  applied, 2 failed"). The word stays mounted so the colour settles. */
export function StateWord({ status, words, className }: { status: OrgChangeStatus | SubjectStatus; words?: string; className?: string }) {
  const meta = STATE_WORDS[status];
  if (!meta) return null;
  return <span className={cn("org-pop-in whitespace-nowrap text-[12.5px] leading-[21px] transition-colors [transition-duration:400ms] motion-reduce:transition-none", meta[1], className)} data-subject-state={status}>{words ?? meta[0]}</span>;
}

/** Under an entry once the send went: "Noted, waiting for a revision" on a
 *  card the person wrote back on, which the agent has yet to amend. */
export function NotedLine({ className }: { className?: string }) {
  return <p className={cn("m-0 text-[11px] leading-[18px]", QUIET, className)} data-subject-noted>{ORG_REPLY_WORDS.note.done}, waiting for a revision</p>;
}

export function FailNote({ note, className }: { note: string; className?: string }) {
  return <p className={cn("m-0 text-[12.5px] leading-[1.55]", TEXT, className)} data-failed-note><b className={cn("font-semibold", RED)}>{note ? "Failed:" : "Failed."}</b>{note ? ` ${note}` : ""}</p>;
}

/** The subject's name is the sentence's one bold run, or `subject` in its
 *  place: a record that exists reads as its pill, the way codecast names it
 *  everywhere else. */
export function Sentence({ text, span, name, subject }: { text: string; span: [number, number] | null; name: string; subject?: React.ReactNode }) {
  if (!span) return <>{text}</>;
  return <>{text.slice(0, span[0])}{subject ?? <b className={name}>{text.slice(span[0], span[1])}</b>}{text.slice(span[1])}</>;
}

/** The pill for a record a change names, when the change names one that already exists. */
export function recordRef(change: OrgProposalChange["change"]): { type: "task" | "plan"; id: string } | null {
  if (change.kind === "task_status") return { type: "task", id: change.task };
  if (change.kind === "plan_status") return { type: "plan", id: change.plan };
  return null;
}

export function RecordPill({ type, id, title }: { type: "task" | "plan"; id: string; title: string }) {
  return <span className="inline-block align-baseline" {...LEDGER_STOP} data-subject-pill={type}><EntityIdPill id={id} type={type} label={title} /></span>;
}

// ---------------------------------------------------------------- layout

// Wide (over 560px of card): number, reading column, verdict gutter (196px:
// Approve, Reject and Reply on one line). Narrow: number and reading column,
// with the answers in a right aligned row under the entry. With no layout
// given the card asks its own width. Tailwind reads these strings whole, so
// each form is written out.
export const AT = {
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
export type LedgerLayout = keyof typeof AT.grid;
export const SLOT = "flex h-[21px] items-center justify-self-end gap-0.5 whitespace-nowrap";

// ---------------------------------------------------------------- the entry

export type ProposalSubjectCardProps = {
  card: SubjectCard;
  /** The card's place in its list, from 1: the number column. Absent on a card that stands alone, which then draws no rule and no padding of its own. */
  ordinal?: number;
  /** Where the answers sit. Absent: the card asks its own width (wide over 560px). */
  layout?: "wide" | "narrow";
  /** A card that stands alone in its frame: its Approve is the frame's one filled button, until pressed. */
  lead?: boolean;
  /** This card's pending answer, from the batch. */
  answer?: SubjectAnswer | null;
  /** Put, replace (same verdict, new words) or withdraw (null) this card's answer. Absent: read only. */
  onAnswer?: (answer: SubjectAnswer | null) => void;
  /** What approving would take over (R1): the phrase, and the "leave them" box, whose tick rides on the approval as `leave_sessions`. */
  takeover?: { phrase: string };
  /** Revised since the reader last looked (S18). */
  revisedNew?: boolean;
  /** The store's focus (orgFocusChangeId) names a change of this card: marked, and scrolled into view once. */
  focused?: boolean;
  className?: string;
};

type Group = { key: string; change: OrgProposalChange | null; rows: ChangeField[]; reasons: string[] };

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

/** Scroll the focused entry into view once, when it mounts focused. */
export function useFocusScroll(ref: React.RefObject<HTMLElement | null>, focused: boolean | undefined) {
  const done = useRef(false);
  useWatchEffect(() => {
    if (!focused || done.current) return;
    done.current = true;
    ref.current?.scrollIntoView?.({ block: "center" });
  }, [focused, ref]);
}

export function ProposalSubjectCard({ card, ordinal, layout, lead, answer, onAnswer, takeover, revisedNew, focused, className }: ProposalSubjectCardProps) {
  const hover = useOrgHover();
  // A ghost line on the company document points at one of this card's
  // changes, or this card points at its line (lightChanges on hover).
  const lit = useChangeLit(card.change_ids);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusScroll(rootRef, focused);
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
  const words = <span className={cn("text-[12.5px] leading-[21px]", MUTED)} data-subject-state={state}>{subjectStatusWords(card)}</span>;
  // The stored answer the row still carries (a rejection's words, a note), once the send went.
  const stored = (change: OrgProposalChange | null) => (change ? changeReply(change) : card.reply);
  const noted = (reply: OrgChangeReply | null, status: OrgChangeStatus | SubjectStatus) => reply?.verdict === "note" && isOrgChangeDecidable(status as OrgChangeStatus);
  // The answer is staged: the controls give way to the band.
  const staged = !!answer && !!onAnswer && card.waiting > 0;
  const pendingText = answer?.text?.trim() ? answer.text : null;
  const storedYou = (change: OrgProposalChange | null) => {
    const reply = stored(change);
    return reply?.text?.trim() ? <LedgerYou text={reply.text} onEdit={onAnswer && card.waiting > 0 ? () => setFieldOpen(true) : undefined} className="mt-1.5" data-subject-you={reply.verdict} /> : null;
  };

  const text = card.sentence;
  const span = card.subjectSpan;
  const sentenceTone = state === "applied" ? MUTED : state === "skipped" ? QUIET : TEXT;
  const nameTone = state === "applied" ? cn("font-semibold", SOFT) : state === "skipped" ? "font-medium" : "font-bold";
  const numberTone = card.status === "failed" ? RED : QUIET;
  const leadId = card.changes[0]?._id ?? card.change_ids[0];
  const record: RecordKind | undefined = card.face.kind === "record" ? card.face.record : card.kind === "project" ? "project" : undefined;
  const pillRef = card.changes[0] ? recordRef(card.changes[0].change) : null;

  const mode: LedgerLayout = layout ?? "auto";
  const groups = settled && state === "skipped" ? [] : groupsOf(card, split);
  const groupTone = (status: OrgChangeStatus | SubjectStatus) => (status === "applied" ? SOFT : status === "skipped" ? QUIET : TEXT);
  // Notes with no group to sit under: the whole card failed, or something that rides along did.
  const looseNotes = [...new Set(card.failed.filter((f) => !split || !card.seqs.includes(f.seq)).map((f) => f.note))];
  const top = split ? words
    : card.waiting === 0 ? <StateWord status={card.status} />
    : !onAnswer ? words
    : staged ? null
    : controls(card.status === "failed", lead);
  const revisionKind = (seq: number) => card.changes.find((c) => c.seq === seq)?.revision?.kind;
  const sources = card.evidence;
  const field = replyField({});

  return (
    <div
      ref={rootRef}
      className={cn("not-prose min-w-0 text-left transition-[background-color,box-shadow] duration-150", LEDGER_INKS, !layout && "[container-type:inline-size]", ordinal != null && "border-t", className)}
      style={{ borderColor: LEDGER_HAIR, ...(lit ? { background: "color-mix(in srgb, var(--sol-violet) 11%, transparent)", boxShadow: "inset 2px 0 0 var(--sol-violet)" } : {}) }}
      onMouseEnter={() => { hover?.(leadId); lightChanges(card.change_ids); }}
      onMouseLeave={() => { hover?.(null); lightChanges(null); }}
      onFocus={() => { hover?.(leadId); lightChanges(card.change_ids); }}
      onBlur={() => { hover?.(null); lightChanges(null); }}
      data-layout={mode}
      data-settled={settled || undefined}
      data-subject={card.key}
      data-subject-kind={card.kind}
      data-subject-status={card.status}
      data-change-ids={card.change_ids.join(" ")}
      data-subject-answer={answer?.verdict}
      data-revised-new={revisedNew || undefined}
      data-focused={focused || undefined}
      data-lit={lit || undefined}
    >
      <div
        className={cn("grid items-baseline", AT.grid[mode], ordinal != null && AT.pad[mode])}
        style={{ ...(ordinal == null ? { "--num": "0px" } : {}), "--verdict-gap": card.waiting > 0 ? "12px" : "4px" } as React.CSSProperties}
      >
        {ordinal != null && <span className={cn("col-start-1 text-[11px] leading-[20px] tabular-nums", EASE, numberTone)} data-subject-ordinal>{ordinal}</span>}
        <p className={cn("col-start-2 m-0 font-normal [overflow-wrap:anywhere] [text-wrap:pretty]", SENTENCE, EASE, sentenceTone)} data-subject-sentence>
          <Sentence text={text} span={span} name={nameTone} subject={pillRef && <RecordPill {...pillRef} title={card.title} />} />
        </p>
        {top && <div className={cn(SLOT, AT.verdicts[mode])} {...LEDGER_STOP} data-subject-verdicts>{top}</div>}

        {revisedNew && <p className="org-pop-in col-start-2 m-0 mt-1 text-[11px] leading-[18px] text-[color:var(--ink-violet)]">Revised since you last looked</p>}
        {looseNotes.map((note) => <FailNote key={note} note={note} className="col-start-2 mt-1.5" />)}

        {groups.map((group, i) => {
          const status = group.change?.status ?? card.status;
          const failed = split && group.change ? card.failed.find((f) => f.seq === group.change!.seq) : undefined;
          const reply = split ? stored(group.change) : null;
          return (
            <React.Fragment key={group.key}>
              <div className={cn("col-start-2 min-w-0", i === 0 ? "mt-2" : "mt-[18px]")} data-subject-group={group.change?.seq ?? "all"}>
                <Fields fields={group.rows} faces={card.faces} tone={groupTone(split ? status : state)} clamp={!card.purpose} record={record} />
                {failed && <FailNote note={failed.note} className="mt-1.5" />}
                {!settled && group.reasons.length > 0 && (
                  <div className={cn("mt-2 max-w-[70ch] space-y-1 text-[12.5px] leading-[1.6] [text-wrap:pretty]", EASE, state === "accepted" ? QUIET : MUTED)} data-subject-reasons>
                    {group.reasons.map((reason) => <Clamp key={reason}>{reason}</Clamp>)}
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
                  {!isOrgChangeDecidable(group.change.status) ? <StateWord status={group.change.status} /> : onAnswer && !staged ? controls(group.change.status === "failed") : null}
                </div>
              )}
            </React.Fragment>
          );
        })}

        {/* The stored words on the card once the send went, and "Noted" while the author has yet to amend. */}
        {!split && !staged && (() => { const you = storedYou(null); return you && <div className="col-start-2 min-w-0">{you}</div>; })()}
        {!split && !pendingText && noted(card.reply, card.status) && <NotedLine className="col-start-2 mt-1" />}

        {!settled && card.depends.map((line) => <p key={line} className={cn("col-start-2 m-0 mt-1.5 text-[11px] leading-[18px]", QUIET)} data-subject-depends>{line}</p>)}
        {!settled && card.revisions.map((rev) => (
          <div key={rev.seq} className={cn("col-start-2 mt-1.5 min-w-0 text-[11px] leading-[18px]", revisedNew && "org-pop-in", QUIET)} data-revision={revisionKind(rev.seq)} data-revision-fields={rev.fields.length}>
            <span className={cn("font-semibold", MUTED)}>{rev.word}</span>{rev.note ? ` ${rev.note}` : ""}
            <Fields fields={rev.fields} faces={card.faces} tone={TEXT} clamp className="mt-1" />
          </div>
        ))}

        {takeover && onAnswer && card.waiting > 0 && !staged && <div className="col-start-2 mt-2" {...LEDGER_STOP}><TakeoverEdit phrase={takeover.phrase} leave={leave} onLeave={onLeave} /></div>}

        {!settled && sources.length > 0 && (
          <div className={cn("col-start-2 mt-[5px] flex min-w-0 flex-wrap items-baseline gap-x-3 text-[11px] leading-[18px]", QUIET)} {...LEDGER_STOP}>
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
          </div>
        )}

        {/* The staged answer, and the field. Keyed siblings: a note's first keystroke mounts the band without remounting the textarea under the caret. */}
        {(staged || field) && (
          <div className="col-start-2 mt-2 min-w-0" {...LEDGER_STOP} data-answer-area>
            {staged && (
              <StagedBand
                key="band"
                answer={answer}
                retry={card.status === "failed"}
                onUndo={() => { put(null); setFieldOpen(false); }}
                you={!open && pendingText ? <LedgerYou text={pendingText} onEdit={() => setFieldOpen(true)} data-subject-you={answer.verdict} /> : undefined}
                takeover={takeover ? { phrase: takeover.phrase, leave, onLeave } : undefined}
                joined={!!field}
              />
            )}
            {field && <div key="field" className={cn(staged && "rounded-b-md px-2.5 pb-2")} style={staged ? { background: stagedWash(answer.verdict) } : undefined}>{field}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
