"use client";
// The record of a goal (docs/architecture/initiatives-projects-role-page.md
// I5; cohesive build spec §5.2): what done looks like, the milestones on the
// way, what is still undecided, what was decided, and who said this and
// where. It sits folded at the foot of the goal's sheet, and only what has
// been written shows: a list nobody has started is one word in the row that
// adds to the record, never a sentence saying it is empty. Every section
// edits in place: the row moves in the store in the same tick
// (`updateInitiative` for the written fields, `recordInitiativeEntry` for one
// entry of a list, named by its key) and the sheet paints from the store. The
// record is keyed by its goal, so a draft or an open form never follows the
// sheet to another goal.
import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Circle, CircleHelp, Flag, Pencil, Plus, Undo2, X, type LucideIcon } from "lucide-react";
import { INITIATIVE_RECORD_MAX, INITIATIVE_RECORD_NOUN, intentSourceAddress, intentSourceKey, milestoneCounts, nextMilestone, orderedMilestones, type InitiativeDecision, type InitiativeMilestone, type InitiativeQuestion, type InitiativeRecordList, type InitiativeRow, type IntentSource } from "@codecast/shared/contracts/initiative";
import { formatTargetDay, targetDayOf, targetDayPassed, targetDayStamp } from "@codecast/shared/time";
import { useInboxStore } from "../../store/inboxStore";
import type { InitiativeRecordOp } from "../../store/initiativeRecord";
import { HEALTH_COLOR, INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { cn } from "../../lib/utils";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { ByChip, SourceLink, shortDate } from "./InitiativeAtoms";
import { RECORD_PARTS as PARTS, recordParts, type RecordPart } from "./recordModel";

export type { RecordPart } from "./recordModel";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const FIELD = "h-7 min-w-0 rounded-md border bg-transparent px-2 text-[12.5px] outline-none placeholder:text-sol-text-dim focus:border-sol-cyan/60";
const META = "flex items-center gap-x-2.5 gap-y-0.5 flex-wrap text-[11px]";

/** A section of a goal's sheet: the small heading every sheet section wears,
 *  a count, one control on the right. The sheet's own sections wear the same
 *  attribute. */
export function RecordSection({ name, label, count, action, children }: { name: string; label: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-initiative-section={name}>
      <SectionHead label={label} count={count} action={action} />
      {children}
    </section>
  );
}

/** The one section heading every sheet draws: a small label, an optional
 *  count, and an action at its right, on a row of one fixed height, so a
 *  heading sits at the same place on every kind of sheet. */
export function SectionHead({ label, count, action }: { label: string; count?: number; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1.5 min-h-[24px]">
      <h3 className="text-[12px] font-normal" style={{ color: "var(--sol-text-dim)" }}>{label}</h3>
      {count ? <span className="text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{count}</span> : null}
      <span className="flex-1" />
      {action}
    </div>
  );
}

const PART_ADD: Record<RecordPart, string> = { done_when: "Done when", milestones: "Milestone", questions: "Question", decisions: "Decision", sources: "Source" };

/** The record: each part that holds something, then one row that starts a
 *  part nobody has written yet. `start` opens a part with its form ready (a
 *  sheet's "write what done looks like"). */
export function InitiativeRecord({ initiative, now, start }: { initiative: InitiativeRow; all?: InitiativeRow[]; now: number; start?: RecordPart | null }) {
  const record = useCallback((op: InitiativeRecordOp) => useInboxStore.getState().recordInitiativeEntry(initiative._id, op), [initiative._id]);
  // A part the person opened stays open until the record moves to another goal.
  const [opened, setOpened] = useState<ReadonlySet<RecordPart>>(() => new Set(start ? [start] : []));
  const filled = new Set(recordParts(initiative));
  const shown = (p: RecordPart) => filled.has(p) || opened.has(p);
  const begun = (p: RecordPart) => opened.has(p) && !filled.has(p);
  const missing = PARTS.filter((p) => !shown(p) && (p === "done_when" || canAdd(initiative, p)));
  return (
    <div key={initiative._id} className="space-y-6" data-initiative-record={initiative.short_id || initiative._id}>
      {shown("done_when") && <Written initiative={initiative} field="done_when" label="Done when" rows={3} placeholder="The sentence a person checks the result against." start={begun("done_when")} />}
      {shown("milestones") && <Milestones initiative={initiative} now={now} record={record} start={begun("milestones")} />}
      {shown("questions") && <Questions initiative={initiative} now={now} record={record} start={begun("questions")} />}
      {shown("decisions") && <Decisions initiative={initiative} now={now} record={record} start={begun("decisions")} />}
      {shown("sources") && <Sources initiative={initiative} now={now} record={record} start={begun("sources")} />}
      {missing.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap" data-initiative-record-add>
          <span className="mr-1 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>Add</span>
          {missing.map((p) => <Ghost key={p} icon={Plus} onClick={() => setOpened(new Set([...opened, p]))} data-initiative-add-part={p}>{PART_ADD[p]}</Ghost>)}
        </div>
      )}
    </div>
  );
}

type Record1 = (op: InitiativeRecordOp) => void;
type DataProps = { [K in `data-${string}`]?: string };

// ------------------------------------------------------------- small parts

function Ghost({ icon: Icon, children, onClick, ...rest }: { icon: LucideIcon; children: ReactNode; onClick?: () => void } & DataProps) {
  return (
    <button type="button" onClick={onClick} className="h-6 inline-flex items-center gap-1 px-2 rounded-md text-[11.5px] font-medium hover:bg-sol-bg-highlight/70 transition-colors" style={{ color: "var(--sol-text-muted)" }} {...rest}>
      <Icon className="w-3 h-3" /> {children}
    </button>
  );
}

/** What a row offers, shown when the row is pointed at or holds focus, and always where nothing hovers. */
function RowActions({ children }: { children: ReactNode }) {
  return <span className="shrink-0 inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">{children}</span>;
}

function RowAction({ icon: Icon, label, onClick, ...rest }: { icon: LucideIcon; label: string; onClick: () => void } & DataProps) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center justify-center w-6 h-6 rounded-md hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-dim)" }} aria-label={label} title={label} {...rest}>
      <Icon className="w-3 h-3" />
    </button>
  );
}

/** Escape cancels; Cmd or Ctrl with Enter saves, and Enter alone does on a one line field. */
const editKeys = (save: () => void, cancel: () => void, oneLine: boolean) => (e: KeyboardEvent) => {
  if (e.key === "Escape") { e.stopPropagation(); cancel(); }
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (oneLine && !e.shiftKey))) { e.preventDefault(); save(); }
};

function FormButtons({ submit, onCancel, onSubmit, disabled }: { submit: string; onCancel: () => void; onSubmit: () => void; disabled?: boolean }) {
  return (
    <>
      <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
      <button type="button" onClick={onSubmit} disabled={disabled} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: "var(--sol-text)", color: "var(--sol-bg)" }} data-initiative-form-submit>{submit}</button>
    </>
  );
}

type FormField = { name: string; placeholder: string; label: string; type?: "text" | "date"; grow?: boolean };

/** One line of fields that adds an entry, or edits the one `initial` holds:
 *  the first is its words and must be filled; the rest are optional. */
function EntryForm({ name, fields, submit, initial, onSubmit, onCancel }: { name: string; fields: FormField[]; submit: string; initial?: Record<string, string>; onSubmit: (values: Record<string, string>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(initial ?? {});
  const first = (values[fields[0].name] ?? "").trim();
  const save = () => { if (first) onSubmit(Object.fromEntries(fields.map((f) => [f.name, (values[f.name] ?? "").trim()]))); };
  return (
    <div className="mt-2 flex items-center gap-1.5 flex-wrap" data-initiative-form={name}>
      {fields.map((f, i) => (
        <input
          key={f.name}
          autoFocus={i === 0}
          type={f.type ?? "text"}
          value={values[f.name] ?? ""}
          onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
          onKeyDown={editKeys(save, onCancel, true)}
          placeholder={f.placeholder}
          aria-label={f.label}
          className={cn(FIELD, f.grow ? "flex-1 basis-[200px]" : f.type === "date" ? "w-[132px] tabular-nums" : "w-[172px]")}
          style={{ borderColor: HAIRLINE, color: "var(--sol-text)" }}
          data-field={f.name}
        />
      ))}
      <span className="ml-auto inline-flex items-center gap-1.5"><FormButtons submit={submit} onCancel={onCancel} onSubmit={save} disabled={!first} /></span>
    </div>
  );
}

/** An entry's own form, in its row's place: Enter saves what changed as one
 *  edit op, Escape leaves the entry as it was. A day reads through the shared
 *  pair and clears when emptied; words are never cleared by an edit, so an
 *  emptied field stays as it was. */
function EditEntry({ list, entryKey, fields, initial, record, onClose }: { list: Exclude<InitiativeRecordList, "sources">; entryKey: string; fields: FormField[]; initial: Record<string, string>; record: Record1; onClose: () => void }) {
  return (
    <EntryForm
      name={`edit-${list}`}
      submit="Save"
      fields={fields}
      initial={initial}
      onCancel={onClose}
      onSubmit={(values) => {
        const entry: Record<string, unknown> = {};
        for (const f of fields) {
          const value = values[f.name];
          if (value === initial[f.name]) continue;
          if (f.type !== "date") { if (value) entry[f.name] = value; continue; }
          const day = value ? targetDayStamp(value) : null;
          if (!value || day) entry[f.name] = day;
        }
        if (Object.keys(entry).length) record({ list, action: "edit", key: entryKey, entry });
        onClose();
      }}
    />
  );
}

function EditAction({ list, onClick }: { list: InitiativeRecordList; onClick: () => void }) {
  return <RowAction icon={Pencil} label={`Edit this ${INITIATIVE_RECORD_NOUN[list]}`} onClick={onClick} data-initiative-edit-entry="" />;
}

// ------------------------------------------------------- why and done when

/** A written field of a goal, edited in place. `fallback` is what reads in
 *  its place while it is unwritten (a goal's description under Why); the
 *  editor still writes the field itself. */
export function Written({ initiative, field, ...rest }: { initiative: InitiativeRow; field: "why" | "done_when"; label: string; rows: number; markdown?: boolean; placeholder: string; start?: boolean; fallback?: string | null }) {
  const save = (next: string) => useInboxStore.getState().updateInitiative(initiative._id, field === "why" ? { why: next || null } : { done_when: next || null });
  return <WrittenField name={field} value={initiative[field] ?? ""} onSave={save} {...rest} />;
}

/** One paragraph a sheet writes in place: a goal's why and what done looks
 *  like, a project's what it is for. Unwritten and with nothing to fall back
 *  on, it is its heading and the one word that writes it. The save goes
 *  through the caller's store action, so the words paint in the same tick. */
export function WrittenField({ name, label, value, onSave, rows, markdown, placeholder, start, fallback }: { name: string; label: string; value: string; onSave: (next: string) => void; rows: number; markdown?: boolean; placeholder: string; start?: boolean; fallback?: string | null }) {
  const shown = value || fallback?.trim() || "";
  const [draft, setDraft] = useState<string | null>(start ? value : null);
  const cancel = () => setDraft(null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next !== value) onSave(next);
    setDraft(null);
  };
  return (
    <RecordSection name={name} label={label} action={draft === null ? <Ghost icon={Pencil} onClick={() => setDraft(value || shown)} data-initiative-edit={name}>{shown ? "Edit" : "Write"}</Ghost> : undefined}>
      {draft !== null ? (
        <div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={editKeys(save, cancel, false)}
            rows={rows}
            placeholder={placeholder}
            aria-label={label}
            className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-sol-text-dim focus:border-sol-cyan/60"
            style={{ borderColor: HAIRLINE }}
            data-initiative-field={name}
          />
          <div className="mt-2 flex justify-end gap-1.5"><FormButtons submit="Save" onCancel={cancel} onSubmit={save} /></div>
        </div>
      ) : !shown ? null : markdown ? (
        <MarkdownRenderer content={shown} className="text-[13px] leading-relaxed" />
      ) : (
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--sol-text-secondary)" }} data-written={name}>{shown}</p>
      )}
    </RecordSection>
  );
}

// -------------------------------------------------------------- milestones

const MILESTONE_FIELDS: FormField[] = [{ name: "title", label: "Milestone", placeholder: "Private beta open", grow: true }, { name: "date", label: "Its day", placeholder: "", type: "date" }];
const QUESTION_FIELDS: FormField[] = [{ name: "text", label: "Question", placeholder: "Do we price per seat?", grow: true }];
const ANSWER_FIELDS: FormField[] = [{ name: "answer", label: "Answer", placeholder: "What was decided", grow: true }];
const DECISION_FIELDS: FormField[] = [{ name: "text", label: "Decision", placeholder: "Ship to brokers first", grow: true }];
const SOURCE_FIELDS: FormField[] = [{ name: "text", label: "Source", placeholder: "ct-12, a link, or the words said", grow: true }, { name: "by", label: "Who said it", placeholder: "Who said it" }];

type MilestoneState = "reached" | "late" | "next" | "ahead";
const milestoneState = (m: InitiativeMilestone, next: InitiativeMilestone | null, now: number): MilestoneState =>
  m.done_at ? "reached" : m.date && targetDayPassed(m.date, now) ? "late" : next?.key === m.key ? "next" : "ahead";

const canAdd = (initiative: InitiativeRow, list: InitiativeRecordList) => (initiative[list]?.length ?? 0) < INITIATIVE_RECORD_MAX[list];

/** The steps on the way, in reading order. Reached ones stay, so the list is
 *  also the record of progress; the next one is marked, and one past its day
 *  is red. */
function Milestones({ initiative, now, record, start }: { initiative: InitiativeRow; now: number; record: Record1; start?: boolean }) {
  const [adding, setAdding] = useState(!!start);
  const rows = orderedMilestones(initiative.milestones);
  const next = nextMilestone(initiative);
  const counts = milestoneCounts(initiative);
  return (
    <RecordSection name="milestones" label="Milestones" count={counts.total} action={!adding && canAdd(initiative, "milestones") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="milestones">Add</Ghost> : undefined}>
      {rows.length > 0 && (
        <ol>
          {rows.map((m, i) => <MilestoneRow key={m.key} milestone={m} state={milestoneState(m, next, now)} isNext={next?.key === m.key} last={i === rows.length - 1} now={now} record={record} />)}
        </ol>
      )}
      {counts.total > 0 && <p className="mt-1.5 pl-[26px] text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} data-initiative-milestone-counts>{counts.done} of {counts.total} reached</p>}
      {adding && (
        <EntryForm
          name="milestones"
          submit="Add"
          fields={MILESTONE_FIELDS}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => { record({ list: "milestones", action: "add", entry: { title: v.title, date: (v.date && targetDayStamp(v.date)) || undefined } }); setAdding(false); }}
        />
      )}
    </RecordSection>
  );
}

function MilestoneRow({ milestone: m, state, isNext, last, now, record }: { milestone: InitiativeMilestone; state: MilestoneState; isNext: boolean; last: boolean; now: number; record: Record1 }) {
  const [editing, setEditing] = useState(false);
  const Icon = state === "reached" ? Check : isNext || state === "late" ? Flag : Circle;
  const tone = state === "late" ? HEALTH_COLOR.off_track : state === "reached" ? "var(--sol-text-dim)" : isNext ? INITIATIVE_ACCENT : "var(--sol-text-dim)";
  if (editing) {
    return (
      <li className="pl-[26px] pb-2" data-initiative-milestone-row={m.key} data-milestone-state={state} data-milestone-next={isNext ? "1" : undefined}>
        <EditEntry list="milestones" entryKey={m.key} fields={MILESTONE_FIELDS} initial={{ title: m.title, date: targetDayOf(m.date) ?? "" }} record={record} onClose={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="group relative flex items-center gap-2 min-h-[28px] pl-[2px]" data-initiative-milestone-row={m.key} data-milestone-state={state} data-milestone-next={isNext ? "1" : undefined}>
      {/* The rail the steps hang on. */}
      {!last && <span className="absolute left-[9px] top-[21px] -bottom-[7px] w-px" style={{ background: HAIRLINE }} aria-hidden />}
      <span className="relative shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full" style={isNext && state !== "late" ? { background: `color-mix(in srgb, ${INITIATIVE_ACCENT} 14%, transparent)` } : undefined}>
        <Icon className={state === "ahead" && !isNext ? "w-[7px] h-[7px]" : "w-3 h-3"} style={{ color: tone }} strokeWidth={state === "reached" ? 2.5 : 2} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 flex items-baseline gap-x-2.5 gap-y-0 flex-wrap py-1">
        <span className={cn("text-[12.5px] leading-snug", isNext && "font-medium")} style={{ color: state === "reached" ? "var(--sol-text-muted)" : "var(--sol-text)" }}>{m.title}</span>
        {isNext && <span className="text-[10.5px] uppercase tracking-wide" style={{ color: state === "late" ? HEALTH_COLOR.off_track : INITIATIVE_ACCENT }}>{state === "late" ? "overdue" : "next"}</span>}
        {m.source && <SourceLink source={m.source} now={now} />}
      </span>
      <RowActions>
        {state === "reached"
          ? <RowAction icon={Undo2} label="Not reached yet" onClick={() => record({ list: "milestones", action: "edit", key: m.key, entry: { done_at: null } })} data-initiative-milestone-reopen="" />
          : <RowAction icon={Check} label="Mark reached" onClick={() => record({ list: "milestones", action: "close", key: m.key })} data-initiative-milestone-reach="" />}
        <EditAction list="milestones" onClick={() => setEditing(true)} />
        <RowAction icon={X} label="Remove this milestone" onClick={() => record({ list: "milestones", action: "remove", key: m.key })} data-initiative-remove="" />
      </RowActions>
      <span className="shrink-0 text-[11.5px] tabular-nums whitespace-nowrap text-right" style={{ color: state === "late" ? HEALTH_COLOR.off_track : "var(--sol-text-dim)" }} data-initiative-milestone-date>
        {m.done_at ? `reached ${shortDate(m.done_at, now)}` : m.date ? formatTargetDay(m.date, now) : ""}
      </span>
    </li>
  );
}

// --------------------------------------------------------------- questions

/** What is still undecided, open ones first. An answer closes a question and
 *  it stays on the record, folded away under the open ones. */
function Questions({ initiative, now, record, start }: { initiative: InitiativeRow; now: number; record: Record1; start?: boolean }) {
  const [adding, setAdding] = useState(!!start);
  const all = initiative.questions ?? [];
  const open = all.filter((q) => !q.answer);
  const answered = all.filter((q) => q.answer).sort((a, b) => (b.answered_at ?? 0) - (a.answered_at ?? 0));
  return (
    <RecordSection name="questions" label="Open questions" count={open.length} action={!adding && canAdd(initiative, "questions") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="questions">Ask</Ghost> : undefined}>
      {open.length > 0 && <ul className="space-y-2">{open.map((q) => <OpenQuestion key={q.key} question={q} now={now} record={record} />)}</ul>}
      {adding && (
        <EntryForm
          name="questions"
          submit="Ask"
          fields={QUESTION_FIELDS}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => { record({ list: "questions", action: "add", entry: { text: v.text } }); setAdding(false); }}
        />
      )}
      {answered.length > 0 && (
        <details className="mt-2.5 group/answered" data-initiative-answered>
          <summary className="cursor-pointer select-none text-[11.5px] list-none inline-flex items-center gap-1.5 rounded-md hover:text-sol-text" style={{ color: "var(--sol-text-dim)" }}>
            <Check className="w-3 h-3" aria-hidden /> {answered.length} answered
          </summary>
          <ul className="mt-2 space-y-2.5">
            {answered.map((q) => <AnsweredQuestion key={q.key} question={q} now={now} record={record} />)}
          </ul>
        </details>
      )}
    </RecordSection>
  );
}

function AnsweredQuestion({ question: q, now, record }: { question: InitiativeQuestion; now: number; record: Record1 }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li data-initiative-question={q.key} data-question-state="answered">
        <EditEntry list="questions" entryKey={q.key} fields={[...QUESTION_FIELDS, ...ANSWER_FIELDS]} initial={{ text: q.text, answer: q.answer ?? "" }} record={record} onClose={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="group flex items-start gap-2" data-initiative-question={q.key} data-question-state="answered">
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>{q.text}</p>
        <p className="mt-1 pl-2.5 border-l text-[12.5px] leading-snug" style={{ borderColor: HAIRLINE, color: "var(--sol-text)" }} data-initiative-answer>{q.answer}</p>
        <div className={cn(META, "mt-1")} style={{ color: "var(--sol-text-dim)" }}>
          <ByChip by={q.by} />
          {q.answered_at ? <span className="tabular-nums">answered {shortDate(q.answered_at, now)}</span> : null}
          {q.source && <SourceLink source={q.source} now={now} />}
        </div>
      </div>
      <RowActions>
        <EditAction list="questions" onClick={() => setEditing(true)} />
        <RowAction icon={X} label="Remove this question" onClick={() => record({ list: "questions", action: "remove", key: q.key })} data-initiative-remove="" />
      </RowActions>
    </li>
  );
}

function OpenQuestion({ question: q, now, record }: { question: InitiativeQuestion; now: number; record: Record1 }) {
  const [answering, setAnswering] = useState(false);
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="pl-5" data-initiative-question={q.key} data-question-state="open">
        <EditEntry list="questions" entryKey={q.key} fields={QUESTION_FIELDS} initial={{ text: q.text }} record={record} onClose={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="group" data-initiative-question={q.key} data-question-state="open">
      <div className="flex items-start gap-2">
        <CircleHelp className="mt-[3px] w-3 h-3 shrink-0" style={{ color: INITIATIVE_ACCENT }} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>{q.text}</p>
          <div className={cn(META, "mt-0.5")} style={{ color: "var(--sol-text-dim)" }}>
            <ByChip by={q.by} />
            <span className="tabular-nums">asked {shortDate(q.at, now)}</span>
            {q.source && <SourceLink source={q.source} now={now} />}
          </div>
        </div>
        {!answering && (
          <RowActions>
            <Ghost icon={Check} onClick={() => setAnswering(true)} data-initiative-answer-open="">Answer</Ghost>
            <EditAction list="questions" onClick={() => setEditing(true)} />
            <RowAction icon={X} label="Remove this question" onClick={() => record({ list: "questions", action: "remove", key: q.key })} data-initiative-remove="" />
          </RowActions>
        )}
      </div>
      {answering && (
        <div className="pl-5">
          <EntryForm
            name="answer"
            submit="Answer"
            fields={ANSWER_FIELDS}
            onCancel={() => setAnswering(false)}
            onSubmit={(v) => { record({ list: "questions", action: "close", key: q.key, answer: v.answer }); setAnswering(false); }}
          />
        </div>
      )}
    </li>
  );
}

// --------------------------------------------------------------- decisions

/** What was decided, newest first, each with who decided it, when and where. */
function Decisions({ initiative, now, record, start }: { initiative: InitiativeRow; now: number; record: Record1; start?: boolean }) {
  const [adding, setAdding] = useState(!!start);
  const rows = (initiative.decisions ?? []).map((d, i) => ({ d, i })).sort((a, b) => b.d.at - a.d.at || b.i - a.i).map((x) => x.d);
  return (
    <RecordSection name="decisions" label="Decisions" count={rows.length} action={!adding && canAdd(initiative, "decisions") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="decisions">Record</Ghost> : undefined}>
      {adding && (
        <div className="mb-2.5">
          <EntryForm
            name="decisions"
            submit="Record"
            fields={[...DECISION_FIELDS, { name: "source", label: "Where it was decided", placeholder: "Where: ct-12, a link" }]}
            onCancel={() => setAdding(false)}
            onSubmit={(v) => { record({ list: "decisions", action: "add", entry: { text: v.text, source: v.source ? { text: v.source } : undefined } }); setAdding(false); }}
          />
        </div>
      )}
      {rows.length > 0 && <ul className="space-y-2">{rows.map((d) => <DecisionRow key={d.key} decision={d} now={now} record={record} />)}</ul>}
    </RecordSection>
  );
}

function DecisionRow({ decision: d, now, record }: { decision: InitiativeDecision; now: number; record: Record1 }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="pl-5" data-initiative-decision={d.key}>
        <EditEntry list="decisions" entryKey={d.key} fields={DECISION_FIELDS} initial={{ text: d.text }} record={record} onClose={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="group flex items-start gap-2" data-initiative-decision={d.key}>
      <span className="mt-[7px] w-[5px] h-[5px] rounded-full shrink-0 ml-[3.5px] mr-[3.5px]" style={{ background: "var(--sol-text-dim)" }} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>{d.text}</p>
        <div className={cn(META, "mt-0.5")} style={{ color: "var(--sol-text-dim)" }}>
          <ByChip by={d.by} />
          <span className="tabular-nums">{shortDate(d.at, now)}</span>
          {d.source && <SourceLink source={d.source} now={now} />}
        </div>
      </div>
      <RowActions>
        <EditAction list="decisions" onClick={() => setEditing(true)} />
        <RowAction icon={X} label="Remove this decision" onClick={() => record({ list: "decisions", action: "remove", key: d.key })} data-initiative-remove="" />
      </RowActions>
    </li>
  );
}

// ----------------------------------------------------------------- sources

/** Where the goal was stated: who said it and where, with the words as said. */
function Sources({ initiative, now, record, start }: { initiative: InitiativeRow; now: number; record: Record1; start?: boolean }) {
  const [adding, setAdding] = useState(!!start);
  const rows = initiative.sources ?? [];
  return (
    <RecordSection name="sources" label="Sources" count={rows.length} action={!adding && canAdd(initiative, "sources") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="sources">Add</Ghost> : undefined}>
      {rows.length > 0 && <ul className="space-y-2">{rows.map((s) => <SourceRow key={intentSourceKey(s)} source={s} now={now} record={record} />)}</ul>}
      {adding && (
        <EntryForm
          name="sources"
          submit="Add"
          fields={SOURCE_FIELDS}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => { record({ list: "sources", action: "add", entry: { text: v.text, by: v.by || undefined } }); setAdding(false); }}
        />
      )}
    </RecordSection>
  );
}

/** Who said it, when and where on one line, the way a question and a decision
 *  say it, with the words as said under it. A note has no address: its words
 *  are the row. */
function SourceRow({ source, now, record }: { source: IntentSource; now: number; record: Record1 }) {
  const [editing, setEditing] = useState(false);
  const key = intentSourceKey(source);
  if (editing) {
    // A source is read whole from its text, the way it was added: its address, then the words.
    const initial = { text: [intentSourceAddress(source), source.quote].filter(Boolean).join(" "), by: source.by ?? "" };
    return (
      <li data-initiative-source={key}>
        <EntryForm
          name="edit-sources"
          submit="Save"
          fields={SOURCE_FIELDS}
          initial={initial}
          onCancel={() => setEditing(false)}
          onSubmit={(v) => { if (v.text !== initial.text || v.by !== initial.by) record({ list: "sources", action: "edit", key, entry: { text: v.text, by: v.by } }); setEditing(false); }}
        />
      </li>
    );
  }
  const addressed = source.kind !== "note";
  return (
    <li className="group flex items-start gap-2" data-initiative-source={key}>
      <div className="min-w-0 flex-1 pl-2.5 border-l" style={{ borderColor: HAIRLINE }}>
        {(addressed || source.by || source.at) && (
          <div className={META} style={{ color: "var(--sol-text-dim)" }}>
            <ByChip by={source.by} />
            {source.at ? <span className="tabular-nums">{shortDate(source.at, now)}</span> : null}
            {addressed && <SourceLink source={source} now={now} bare />}
          </div>
        )}
        {source.quote && <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: "var(--sol-text-secondary)" }} data-initiative-source-quote>{source.quote}</p>}
      </div>
      <RowActions>
        <EditAction list="sources" onClick={() => setEditing(true)} />
        <RowAction icon={X} label="Remove this source" onClick={() => record({ list: "sources", action: "remove", key })} data-initiative-remove="" />
      </RowActions>
    </li>
  );
}
