"use client";
// The Goals document's fields written where they read (GoalsDocument.tsx):
// a textarea that grows with its words, a goal's why and done-when edited in
// place, and the numbers a goal or a project reads live from its series.
import { useRef, useState } from "react";
import { Hash } from "lucide-react";
import { metricReadings, metricTrends, type InitiativeMetric, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useMetricSeries } from "../../hooks/useMetricSeries";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { cn } from "../../lib/utils";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { MetricTile } from "../initiatives/InitiativeAtoms";
import { MetricsEditor } from "../initiatives/MetricsEditor";

const DIM = "var(--sol-text-dim)";

// ---------------------------------------------------------------- words in place

/** A textarea that grows with its words and wears the text around it. */
export const AutoTextarea = ({ ref, className, onInput, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: React.Ref<HTMLTextAreaElement> }) => {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => { const el = own.current; if (el) { el.style.height = "0px"; el.style.height = `${el.scrollHeight}px`; } };
  useWatchEffect(fit);
  return (
    <textarea
      ref={(el) => { own.current = el; if (typeof ref === "function") ref(el); else if (ref) (ref as React.RefObject<HTMLTextAreaElement | null>).current = el; }}
      rows={1}
      spellCheck
      onInput={(e) => { fit(); onInput?.(e); }}
      className={cn("block w-full resize-none overflow-hidden bg-transparent p-0 outline-none placeholder:text-sol-text-dim", className)}
      {...rest}
      style={{ color: "inherit", letterSpacing: "inherit", ...rest.style }}
    />
  );
};

/** Why the goal matters, in its owner's words: read as written (markdown) and
 *  written in place with a click. It edits the field it shows: `why` once
 *  written, else the description it reads in its place. */
export function Prose({ goal, placeholder }: { goal: InitiativeRow; placeholder: string }) {
  const field: "why" | "description" = goal.why?.trim() || !goal.description?.trim() ? "why" : "description";
  const value = goal[field] ?? "";
  return <WordsInPlace value={value} placeholder={placeholder} label="Why it matters" className="text-[14px] leading-[1.65]" onSave={(next) => useInboxStore.getState().updateInitiative(goal._id, { [field]: next || null })} data-goal-why={field} />;
}

/** The goal's numbers, each against its target on one line; a click edits them. */
export function Numbers({ goal, now, onEdit }: { goal: InitiativeRow; now: number; onEdit: () => void }) {
  const { lookup } = useMetricSeries();
  const readings = metricReadings(goal, lookup);
  const trends = metricTrends(goal, lookup);
  return (
    <div className="mt-3 flex gap-3" data-goal-numbers>
      <span className="w-[74px] shrink-0 pt-[3px] text-[12px]" style={{ color: DIM }}>{readings.length === 1 ? "Number" : "Numbers"}</span>
      <button type="button" onClick={onEdit} className="-mx-2 -my-0.5 flex min-w-0 flex-1 flex-col items-start gap-1 rounded-md px-2 py-0.5 text-left transition-colors hover:bg-sol-bg-highlight/40" aria-label="Edit the numbers">
        {readings.map((r) => <MetricTile key={r.key} reading={r} trend={trends[r.key]} now={now} size="line" className="max-w-full" />)}
      </button>
    </div>
  );
}

/** A project's numbers under its line, read live; a click edits them. Nothing while it has none and is not being given one. */
export function ProjectNumbers({ projectId, title, now, editing, onEditing }: { projectId: string; title: string; now: number; editing: boolean; onEditing: (on: boolean) => void }) {
  const metrics = useTrackedStore([(s) => (s.projects as any)?.[projectId]?.metrics]).projects?.[projectId]?.metrics as InitiativeMetric[] | undefined;
  const { lookup, watches } = useMetricSeries();
  if (editing) {
    return (
      <div className="mb-2 ml-6 mt-1" data-project-numbers-form={projectId}>
        <MetricsEditor metrics={metrics ?? []} watches={watches} onCancel={() => onEditing(false)} onSave={(next) => { useInboxStore.getState().updateProject(projectId, { metrics: next }); onEditing(false); }} />
      </div>
    );
  }
  if (!metrics?.length) {
    return (
      <button type="button" onClick={() => onEditing(true)} className="absolute -right-14 top-[14px] inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-sol-bg-highlight/70 group-hover/project:opacity-100" style={{ color: DIM }} aria-label={`Give ${title} a number`} title="Give it a number" data-project-add-number>
        <Hash className="h-3.5 w-3.5" />
      </button>
    );
  }
  const row = { metrics };
  const trends = metricTrends(row, lookup);
  return (
    <button type="button" onClick={() => onEditing(true)} className="mb-1 ml-6 flex max-w-full flex-wrap items-center gap-x-4 gap-y-0.5 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-sol-bg-highlight/40" aria-label="Edit the project's numbers" data-project-numbers={projectId}>
      {metricReadings(row, lookup).map((r) => <MetricTile key={r.key} reading={r} trend={trends[r.key]} now={now} size="line" className="max-w-full" />)}
    </button>
  );
}

export function DoneWhen({ goal, start, onDone }: { goal: InitiativeRow; start: boolean; onDone: () => void }) {
  return (
    <div className="mt-3 flex gap-3 text-[13px]" data-goal-done-when>
      <span className="w-[74px] shrink-0 pt-px text-[12px]" style={{ color: DIM }}>Done when</span>
      <WordsInPlace value={goal.done_when ?? ""} start={start} onDone={onDone} placeholder="The sentence a result is checked against." label="Done when" className="min-w-0 flex-1 leading-[1.55]" onSave={(next) => useInboxStore.getState().updateInitiative(goal._id, { done_when: next || null })} />
    </div>
  );
}

/** Words read as written and edited where they stand: a click opens them,
 *  leaving keeps them, Escape puts them back. Empty, the placeholder stands in. */
export function WordsInPlace({ value, onSave, placeholder, label, className, start = false, onDone, ...data }: { value: string; onSave: (next: string) => void; placeholder: string; label: string; className?: string; start?: boolean; onDone?: () => void } & Record<`data-${string}`, string>) {
  const [editing, setEditing] = useState(start);
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  useWatchEffect(() => { if (editing) { const el = ref.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); } }, [editing]);
  const close = () => {
    const next = ref.current?.value.trim() ?? value;
    if (!cancelled.current && next !== value.trim()) onSave(next);
    cancelled.current = false;
    setEditing(false);
    onDone?.();
  };
  if (editing) {
    return (
      <AutoTextarea
        ref={ref}
        defaultValue={value}
        placeholder={placeholder}
        aria-label={label}
        className={cn("-mx-2 -my-1 rounded-md px-2 py-1 ring-1 ring-[color-mix(in_srgb,var(--sol-border)_60%,transparent)]", className)}
        style={{ color: "var(--sol-text)", width: "calc(100% + 1rem)" }}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelled.current = true; ref.current?.blur(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ref.current?.blur(); }
        }}
        {...data}
      />
    );
  }
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) setEditing(true); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEditing(true); } }}
      className={cn("-mx-2 -my-1 cursor-text rounded-md px-2 py-1 outline-none transition-colors hover:bg-sol-bg-highlight/40 focus-visible:bg-sol-bg-highlight/40", className)}
      style={{ color: value ? "var(--sol-text-secondary)" : DIM }}
      aria-label={`${label}: edit`}
      {...data}
    >
      {value ? <MarkdownRenderer content={value} className={cn("goals-prose", className)} /> : <p>{placeholder}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- projects
