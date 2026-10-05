"use client";
// The intent record of a goal
// (docs/architecture/initiatives-projects-role-page.md I5), in the order of
// the test a goal page must pass: why it matters, what done looks like, the
// milestones on the way, what is still undecided, what was decided, and who
// said this and where. Every section edits in place: the row moves in the
// store in the same tick (`updateInitiative` for the two written fields,
// `recordInitiativeEntry` for one entry of a list, named by its key) and the
// page paints from the store.
import { useCallback, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Circle, CircleHelp, Flag, Pencil, Plus, Undo2, X, type LucideIcon } from "lucide-react";
import { INITIATIVE_RECORD_MAX, intentSourceKey, milestoneCounts, nextMilestone, orderedMilestones, type InitiativeDecision, type InitiativeMilestone, type InitiativeQuestion, type InitiativeRecordList, type InitiativeRow, type IntentSource } from "@codecast/shared/contracts/initiative";
import { memberHandle } from "@codecast/shared/chat";
import { targetDayStamp } from "@codecast/shared/time";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import type { InitiativeRecordOp } from "../../store/initiativeRecord";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { memberDisplayName, resolveAssigneeInfo } from "../../lib/liveEntities";
import { HEALTH_COLOR, INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { cn } from "../../lib/utils";
import { AssigneeFace } from "../identity/AssigneeFace";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { SourceLink, shortDate } from "./InitiativeAtoms";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const FIELD = "h-7 min-w-0 rounded-md border bg-transparent px-2 text-[12.5px] outline-none placeholder:text-sol-text-dim focus:border-sol-magenta/60";
const EMPTY = "text-[12.5px] italic";
const META = "flex items-center gap-x-2.5 gap-y-0.5 flex-wrap text-[11px]";

/** A section of the goal page: a small heading, a count, one control on the
 *  right. InitiativePanel's sections wear the same attribute. */
export function RecordSection({ name, label, count, action, children }: { name: string; label: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section data-initiative-section={name}>
      <div className="flex items-center gap-2 mb-2.5 min-h-[24px]">
        <h2 className="text-[12.5px] font-semibold tracking-tight">{label}</h2>
        {count ? <span className="text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }}>{count}</span> : null}
        <span className="flex-1" />
        {action}
      </div>
      {children}
    </section>
  );
}

export function InitiativeRecord({ initiative, now }: { initiative: InitiativeRow; all: InitiativeRow[]; now: number }) {
  const who = useWho();
  const record = useCallback((op: InitiativeRecordOp) => useInboxStore.getState().recordInitiativeEntry(initiative._id, op), [initiative._id]);
  return (
    <div className="space-y-7" data-initiative-record={initiative.short_id || initiative._id}>
      <Written initiative={initiative} field="why" label="Why it matters" rows={4} markdown placeholder="What changes for the company when this is reached, and what it costs to miss it." empty="Nobody has said why this matters yet." />
      <Written initiative={initiative} field="done_when" label="Done when" rows={3} placeholder="The sentence a person checks the result against." empty="Nobody has said what done looks like yet." />
      <Milestones initiative={initiative} now={now} record={record} />
      <Questions initiative={initiative} now={now} record={record} who={who} />
      <Decisions initiative={initiative} now={now} record={record} who={who} />
      <Sources initiative={initiative} now={now} record={record} />
    </div>
  );
}

type Record1 = (op: InitiativeRecordOp) => void;
type Who = (by: string | undefined) => ReturnType<typeof resolveAssigneeInfo>;
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
      <button type="button" onClick={onSubmit} disabled={disabled} className="h-7 px-3 rounded-md text-[12px] font-medium disabled:opacity-45" style={{ background: INITIATIVE_ACCENT, color: "var(--sol-bg)" }} data-initiative-form-submit>{submit}</button>
    </>
  );
}

type FormField = { name: string; placeholder: string; label: string; type?: "text" | "date"; grow?: boolean };

/** One line of fields that adds an entry: the first is its words and must be
 *  filled; the rest are optional. */
function EntryForm({ name, fields, submit, onSubmit, onCancel }: { name: string; fields: FormField[]; submit: string; onSubmit: (values: Record<string, string>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
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

/** Who asked, decided or said it: the roster's face when `by` names a person
 *  or a role here (an @handle, or a name), and the words as written when not. */
function useWho(): Who {
  const { roles } = useOrgRoles();
  const roster = useTeamRosterIdentity();
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  return useCallback((by) => {
    const text = (by ?? "").trim();
    if (!text) return null;
    const handle = text.startsWith("@") ? text.slice(1).toLowerCase() : null;
    const name = text.toLowerCase();
    const person = roster.find((m) => (handle ? memberHandle(m) === handle : memberDisplayName(m, "").toLowerCase() === name));
    const role = person ? undefined : roles.find((r) => (handle ? r.handle === handle : r.name.toLowerCase() === name));
    const id = person?._id ?? role?._id;
    return id ? resolveAssigneeInfo(String(id), undefined, roster as any, s.currentUser as any, roles as any) : null;
  }, [roles, roster, s.currentUser]);
}

function ByChip({ by, who }: { by?: string; who: Who }) {
  if (!by) return null;
  const info = who(by);
  return (
    <span className="inline-flex items-center gap-1 min-w-0" style={{ color: "var(--sol-text-muted)" }} data-initiative-by={info ? "face" : "text"}>
      {info && <AssigneeFace info={info} size={13} />}
      <span className="truncate">{info?.name ?? by}</span>
    </span>
  );
}

// ------------------------------------------------------- why and done when

/** A written field of the record, edited in place. */
function Written({ initiative, field, label, rows, markdown, placeholder, empty }: { initiative: InitiativeRow; field: "why" | "done_when"; label: string; rows: number; markdown?: boolean; placeholder: string; empty: string }) {
  const value = initiative[field] ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const cancel = () => setDraft(null);
  const save = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (next !== value) useInboxStore.getState().updateInitiative(initiative._id, field === "why" ? { why: next || null } : { done_when: next || null });
    setDraft(null);
  };
  return (
    <RecordSection name={field} label={label} action={draft === null ? <Ghost icon={Pencil} onClick={() => setDraft(value)} data-initiative-edit={field}>{value ? "Edit" : "Write"}</Ghost> : undefined}>
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
            className="w-full resize-y rounded-lg border bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-sol-text-dim focus:border-sol-magenta/60"
            style={{ borderColor: HAIRLINE }}
            data-initiative-field={field}
          />
          <div className="mt-2 flex justify-end gap-1.5"><FormButtons submit="Save" onCancel={cancel} onSubmit={save} /></div>
        </div>
      ) : !value ? (
        <p className={EMPTY} style={{ color: "var(--sol-text-dim)" }}>{empty}</p>
      ) : markdown ? (
        <MarkdownRenderer content={value} className="text-[13px] leading-relaxed" />
      ) : (
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--sol-text)" }}>{value}</p>
      )}
    </RecordSection>
  );
}

// -------------------------------------------------------------- milestones

type MilestoneState = "reached" | "late" | "next" | "ahead";
const milestoneState = (m: InitiativeMilestone, next: InitiativeMilestone | null, now: number): MilestoneState =>
  m.done_at ? "reached" : m.date && m.date < now ? "late" : next?.key === m.key ? "next" : "ahead";

const canAdd = (initiative: InitiativeRow, list: InitiativeRecordList) => (initiative[list]?.length ?? 0) < INITIATIVE_RECORD_MAX[list];

/** The steps on the way, in reading order. Reached ones stay, so the list is
 *  also the record of progress; the next one is marked, and one past its day
 *  is red. */
function Milestones({ initiative, now, record }: { initiative: InitiativeRow; now: number; record: Record1 }) {
  const [adding, setAdding] = useState(false);
  const rows = orderedMilestones(initiative.milestones);
  const next = nextMilestone(initiative);
  const counts = milestoneCounts(initiative);
  return (
    <RecordSection name="milestones" label="Milestones" count={counts.total} action={!adding && canAdd(initiative, "milestones") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="milestones">Add</Ghost> : undefined}>
      {rows.length === 0 && !adding ? (
        <p className={EMPTY} style={{ color: "var(--sol-text-dim)" }}>No milestones yet.</p>
      ) : (
        <ol>
          {rows.map((m, i) => <MilestoneRow key={m.key} milestone={m} state={milestoneState(m, next, now)} isNext={next?.key === m.key} last={i === rows.length - 1} now={now} record={record} />)}
        </ol>
      )}
      {counts.total > 0 && <p className="mt-1.5 pl-[26px] text-[11px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} data-initiative-milestone-counts>{counts.done} of {counts.total} reached</p>}
      {adding && (
        <EntryForm
          name="milestones"
          submit="Add"
          fields={[{ name: "title", label: "Milestone", placeholder: "Private beta open", grow: true }, { name: "date", label: "Its day", placeholder: "", type: "date" }]}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => { record({ list: "milestones", action: "add", entry: { title: v.title, date: (v.date && targetDayStamp(v.date)) || undefined } }); setAdding(false); }}
        />
      )}
    </RecordSection>
  );
}

function MilestoneRow({ milestone: m, state, isNext, last, now, record }: { milestone: InitiativeMilestone; state: MilestoneState; isNext: boolean; last: boolean; now: number; record: Record1 }) {
  const Icon = state === "reached" ? Check : isNext || state === "late" ? Flag : Circle;
  const tone = state === "late" ? HEALTH_COLOR.off_track : state === "reached" ? "var(--sol-text-dim)" : isNext ? INITIATIVE_ACCENT : "var(--sol-text-dim)";
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
        <RowAction icon={X} label="Remove this milestone" onClick={() => record({ list: "milestones", action: "remove", key: m.key })} data-initiative-remove="" />
      </RowActions>
      <span className="shrink-0 text-[11.5px] tabular-nums whitespace-nowrap text-right" style={{ color: state === "late" ? HEALTH_COLOR.off_track : "var(--sol-text-dim)" }} data-initiative-milestone-date>
        {m.done_at ? `reached ${shortDate(m.done_at, now)}` : m.date ? shortDate(m.date, now) : ""}
      </span>
    </li>
  );
}

// --------------------------------------------------------------- questions

/** What is still undecided, open ones first. An answer closes a question and
 *  it stays on the record, folded away under the open ones. */
function Questions({ initiative, now, record, who }: { initiative: InitiativeRow; now: number; record: Record1; who: Who }) {
  const [adding, setAdding] = useState(false);
  const all = initiative.questions ?? [];
  const open = all.filter((q) => !q.answer);
  const answered = all.filter((q) => q.answer).sort((a, b) => (b.answered_at ?? 0) - (a.answered_at ?? 0));
  return (
    <RecordSection name="questions" label="Open questions" count={open.length} action={!adding && canAdd(initiative, "questions") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="questions">Ask</Ghost> : undefined}>
      {open.length === 0 && !adding && <p className={EMPTY} style={{ color: "var(--sol-text-dim)" }}>Nothing is waiting on an answer.</p>}
      {open.length > 0 && <ul className="space-y-2">{open.map((q) => <OpenQuestion key={q.key} question={q} now={now} record={record} who={who} />)}</ul>}
      {adding && (
        <EntryForm
          name="questions"
          submit="Ask"
          fields={[{ name: "text", label: "Question", placeholder: "Do we price per seat?", grow: true }]}
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
            {answered.map((q) => (
              <li key={q.key} className="group flex items-start gap-2" data-initiative-question={q.key} data-question-state="answered">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text-muted)" }}>{q.text}</p>
                  <p className="mt-1 pl-2.5 border-l text-[12.5px] leading-snug" style={{ borderColor: HAIRLINE, color: "var(--sol-text)" }} data-initiative-answer>{q.answer}</p>
                  <div className={cn(META, "mt-1")} style={{ color: "var(--sol-text-dim)" }}>
                    <ByChip by={q.by} who={who} />
                    {q.answered_at ? <span className="tabular-nums">answered {shortDate(q.answered_at, now)}</span> : null}
                    {q.source && <SourceLink source={q.source} now={now} />}
                  </div>
                </div>
                <RowActions><RowAction icon={X} label="Remove this question" onClick={() => record({ list: "questions", action: "remove", key: q.key })} data-initiative-remove="" /></RowActions>
              </li>
            ))}
          </ul>
        </details>
      )}
    </RecordSection>
  );
}

function OpenQuestion({ question: q, now, record, who }: { question: InitiativeQuestion; now: number; record: Record1; who: Who }) {
  const [answering, setAnswering] = useState(false);
  return (
    <li className="group" data-initiative-question={q.key} data-question-state="open">
      <div className="flex items-start gap-2">
        <CircleHelp className="mt-[3px] w-3 h-3 shrink-0" style={{ color: INITIATIVE_ACCENT }} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>{q.text}</p>
          <div className={cn(META, "mt-0.5")} style={{ color: "var(--sol-text-dim)" }}>
            <ByChip by={q.by} who={who} />
            <span className="tabular-nums">asked {shortDate(q.at, now)}</span>
            {q.source && <SourceLink source={q.source} now={now} />}
          </div>
        </div>
        {!answering && (
          <RowActions>
            <Ghost icon={Check} onClick={() => setAnswering(true)} data-initiative-answer-open="">Answer</Ghost>
            <RowAction icon={X} label="Remove this question" onClick={() => record({ list: "questions", action: "remove", key: q.key })} data-initiative-remove="" />
          </RowActions>
        )}
      </div>
      {answering && (
        <div className="pl-5">
          <EntryForm
            name="answer"
            submit="Answer"
            fields={[{ name: "answer", label: "Answer", placeholder: "What was decided", grow: true }]}
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
function Decisions({ initiative, now, record, who }: { initiative: InitiativeRow; now: number; record: Record1; who: Who }) {
  const [adding, setAdding] = useState(false);
  const rows = (initiative.decisions ?? []).map((d, i) => ({ d, i })).sort((a, b) => b.d.at - a.d.at || b.i - a.i).map((x) => x.d);
  return (
    <RecordSection name="decisions" label="Decisions" count={rows.length} action={!adding && canAdd(initiative, "decisions") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="decisions">Record</Ghost> : undefined}>
      {rows.length === 0 && !adding && <p className={EMPTY} style={{ color: "var(--sol-text-dim)" }}>No decisions recorded yet.</p>}
      {adding && (
        <div className="mb-2.5">
          <EntryForm
            name="decisions"
            submit="Record"
            fields={[{ name: "text", label: "Decision", placeholder: "Ship to brokers first", grow: true }, { name: "source", label: "Where it was decided", placeholder: "Where: ct-12, a link" }]}
            onCancel={() => setAdding(false)}
            onSubmit={(v) => { record({ list: "decisions", action: "add", entry: { text: v.text, source: v.source ? { text: v.source } : undefined } }); setAdding(false); }}
          />
        </div>
      )}
      {rows.length > 0 && <ul className="space-y-2">{rows.map((d) => <DecisionRow key={d.key} decision={d} now={now} record={record} who={who} />)}</ul>}
    </RecordSection>
  );
}

function DecisionRow({ decision: d, now, record, who }: { decision: InitiativeDecision; now: number; record: Record1; who: Who }) {
  return (
    <li className="group flex items-start gap-2" data-initiative-decision={d.key}>
      <span className="mt-[7px] w-[5px] h-[5px] rounded-full shrink-0 ml-[3.5px] mr-[3.5px]" style={{ background: "var(--sol-text-dim)" }} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>{d.text}</p>
        <div className={cn(META, "mt-0.5")} style={{ color: "var(--sol-text-dim)" }}>
          <ByChip by={d.by} who={who} />
          <span className="tabular-nums">{shortDate(d.at, now)}</span>
          {d.source && <SourceLink source={d.source} now={now} />}
        </div>
      </div>
      <RowActions><RowAction icon={X} label="Remove this decision" onClick={() => record({ list: "decisions", action: "remove", key: d.key })} data-initiative-remove="" /></RowActions>
    </li>
  );
}

// ----------------------------------------------------------------- sources

/** Where the goal was stated: who said it and where, with the words as said. */
function Sources({ initiative, now, record }: { initiative: InitiativeRow; now: number; record: Record1 }) {
  const [adding, setAdding] = useState(false);
  const rows = initiative.sources ?? [];
  return (
    <RecordSection name="sources" label="Sources" count={rows.length} action={!adding && canAdd(initiative, "sources") ? <Ghost icon={Plus} onClick={() => setAdding(true)} data-initiative-add="sources">Add</Ghost> : undefined}>
      {rows.length === 0 && !adding && <p className={EMPTY} style={{ color: "var(--sol-text-dim)" }}>Nobody has said where this goal was stated.</p>}
      {rows.length > 0 && <ul className="space-y-2">{rows.map((s) => <SourceRow key={intentSourceKey(s)} source={s} now={now} record={record} />)}</ul>}
      {adding && (
        <EntryForm
          name="sources"
          submit="Add"
          fields={[{ name: "text", label: "Source", placeholder: "ct-12, a link, or the words said", grow: true }, { name: "by", label: "Who said it", placeholder: "Who said it" }]}
          onCancel={() => setAdding(false)}
          onSubmit={(v) => { record({ list: "sources", action: "add", entry: { text: v.text, by: v.by || undefined } }); setAdding(false); }}
        />
      )}
    </RecordSection>
  );
}

function SourceRow({ source, now, record }: { source: IntentSource; now: number; record: Record1 }) {
  const key = intentSourceKey(source);
  return (
    <li className="group flex items-start gap-2" data-initiative-source={key}>
      <div className="min-w-0 flex-1 pl-2.5 border-l" style={{ borderColor: HAIRLINE }}>
        <SourceLink source={source} now={now} />
        {source.quote && <p className="mt-0.5 text-[12.5px] leading-snug" style={{ color: "var(--sol-text-secondary)" }} data-initiative-source-quote>{source.quote}</p>}
      </div>
      <RowActions><RowAction icon={X} label="Remove this source" onClick={() => record({ list: "sources", action: "remove", key })} data-initiative-remove="" /></RowActions>
    </li>
  );
}
