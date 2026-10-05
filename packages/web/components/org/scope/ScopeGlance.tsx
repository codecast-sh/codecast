"use client";
// The role page's panel, collapsed (docs/architecture/scopes-and-feed.md
// F4.1): the page opens on the conversation, and this strip under the header
// says what the panel would. Its top line is the goal the area serves when
// one is written down (initiatives-projects-role-page.md I4), else what the
// role is for; under it, what the role is doing and what is open in its area.
// Each fact opens the panel on the tab that holds it.
import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, Target } from "lucide-react";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useRoleScope } from "../../../hooks/useRoleScope";
import { initiativeRelation } from "../../../lib/roleInitiatives";
import { INITIATIVE_ACCENT } from "../../../lib/initiativeColors";
import { HealthChip } from "../../initiatives/InitiativeAtoms";
import type { ScopeTabKey } from "../../../lib/scopeTabs";
import type { OrgRole } from "../orgTypes";
import type { ScopeSummary } from "./scopeTypes";
import { RoleDoing } from "./ScopePanel";

export function ScopeGlance({ role, summary, onOpen }: { role: OrgRole; summary: ScopeSummary | null | undefined; onOpen: (tab: ScopeTabKey) => void }) {
  const goals = useRoleScope(role.short_id).model?.initiatives ?? [];
  const goal = goals[0];
  const charter = (role.charter ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  const tasks = summary?.tasks.open ?? 0;
  const decisions = summary?.decisions.open ?? 0;
  const now = useCoarseNow(60_000);
  return (
    <div
      className="shrink-0 border-b px-4 py-1.5 flex flex-col gap-0.5 text-[12px] cursor-pointer transition-colors hover:bg-sol-bg-highlight/30"
      style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}
      onClick={() => onOpen("scope")}
      data-scope-glance={goal ? goal.ref : "charter"}
    >
      {goal ? (
        <div className="flex items-center gap-2 min-w-0" data-scope-glance-goal={goal.ref}>
          <Target className="w-3.5 h-3.5 shrink-0" style={{ color: INITIATIVE_ACCENT }} aria-hidden />
          <Link href={`/initiatives/${goal.ref}`} onClick={(e) => e.stopPropagation()} className="min-w-0 truncate font-semibold text-sol-text no-underline hover:underline underline-offset-2">{goal.title}</Link>
          {goal.health !== "none" && <HealthChip health={goal.health} at={goal.health_at} now={now} className="shrink-0" />}
          <span className="shrink-0" style={{ color: goal.owned ? "var(--sol-violet)" : "var(--sol-text-dim)" }}>{initiativeRelation(goal)}</span>
          {goals.length > 1 && <span className="shrink-0" style={{ color: "var(--sol-text-dim)" }}>+{goals.length - 1} more</span>}
        </div>
      ) : charter ? (
        <p className="truncate" style={{ color: "var(--sol-text-secondary)" }} title={charter} data-scope-glance-charter>{charter}</p>
      ) : null}
      <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap min-w-0" style={{ color: "var(--sol-text-muted)" }}>
        <RoleDoing role={role} short className="text-[12px]" />
        {tasks > 0 && <Fact onClick={() => onOpen("work")} data-scope-glance-fact="tasks">{tasks} open {tasks === 1 ? "task" : "tasks"}</Fact>}
        {decisions > 0 && <Fact onClick={() => onOpen("decisions")} data-scope-glance-fact="decisions" accent>{decisions} {decisions === 1 ? "decision" : "decisions"} open</Fact>}
        <span className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-[11.5px]" style={{ color: "var(--sol-violet)" }}>Overview <ChevronRight className="w-3 h-3" /></span>
      </div>
    </div>
  );
}

function Fact({ onClick, accent, children, ...rest }: { onClick: () => void; accent?: boolean; children: ReactNode } & Record<`data-${string}`, string>) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onClick(); }} className="shrink-0 hover:underline underline-offset-2" style={accent ? { color: "var(--sol-yellow)" } : undefined} {...rest}>
      <span style={{ color: "var(--sol-text-dim)" }}>· </span>{children}
    </button>
  );
}
