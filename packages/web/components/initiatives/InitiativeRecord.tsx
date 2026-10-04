"use client";
// The intent record of a goal
// (docs/architecture/initiatives-projects-role-page.md I5), in the order of
// the test a goal page must pass: why it matters, what done looks like, the
// milestones on the way, what is still undecided, what was decided, and who
// said this and where.
import type { ReactNode } from "react";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";

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

export function InitiativeRecord({ initiative }: { initiative: InitiativeRow; all: InitiativeRow[]; now: number }) {
  return (
    <div className="space-y-7" data-initiative-record={initiative.short_id || initiative._id}>
      <RecordSection name="why" label="Why it matters">{null}</RecordSection>
      <RecordSection name="done_when" label="Done when">{null}</RecordSection>
      <RecordSection name="milestones" label="Milestones">{null}</RecordSection>
      <RecordSection name="questions" label="Open questions">{null}</RecordSection>
      <RecordSection name="decisions" label="Decisions">{null}</RecordSection>
      <RecordSection name="sources" label="Sources">{null}</RecordSection>
    </div>
  );
}
