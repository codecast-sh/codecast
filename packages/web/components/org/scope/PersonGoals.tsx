"use client";
// A person's goals as the role keeps them (docs/architecture/
// org-roles-run-work.md R6): each goal in the person's words, what the role
// matched to it, and what moved or stalled. The rows come from org.brief's
// `facts.people`, which reads the brief's goal section against the live rows
// with the viewer's grants, so this only draws them. The Scope tab shows the
// viewer their own goals; the Brief tab shows every person who reports.
import { goalStateLine } from "@codecast/shared/contracts/roleGoals";
import { EntityIdPill } from "../../EntityIdPill";
import type { BriefPerson } from "./scopeTypes";

const TONE = { stalled: "var(--sol-yellow)", moved: "var(--sol-green)", quiet: "var(--sol-text-dim)" } as const;

export function PersonGoals({ person, roleHandle, now, own }: { person: BriefPerson; roleHandle: string; now: number; own: boolean }) {
  if (!person.has_section || person.goals.length === 0) {
    return (
      <p className="px-2.5 text-[12px] text-sol-text-muted" data-person-goals="0">
        {own ? "You report" : `${person.name} reports`} to @{roleHandle}, and it holds no goals for {own ? "you" : "them"} yet. Tell it {own ? "your" : "their"} three to five goals in the conversation, or write them on the Brief tab under “## Goals: {person.name}”.
      </p>
    );
  }
  return (
    <ol className="space-y-1" data-person-goals={person.goals.length}>
      {person.goals.map((g, i) => {
        const tone = g.stalled || g.unmatched ? TONE.stalled : g.moved_at !== null ? TONE.moved : TONE.quiet;
        return (
          <li key={i} className="flex items-start gap-2.5 px-2.5 py-1.5 rounded-lg" data-goal-stalled={g.stalled ? "1" : "0"}>
            <span className="w-[3px] self-stretch rounded-full shrink-0" style={{ background: tone }} />
            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] font-medium text-sol-text">
                {g.text}
                {g.priority && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: g.priority === "high" ? "var(--sol-orange)" : "var(--sol-text-dim)" }}>{g.priority}</span>}
              </span>
              {g.refs.length > 0 && (
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-sol-text-muted">
                  {g.refs.map((r) => <EntityIdPill key={r.short_id} shortId={r.short_id} compact />)}
                </span>
              )}
              <span className="block mt-0.5 text-[11.5px]" style={{ color: tone }} data-goal-state>{goalStateLine(g, now)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
