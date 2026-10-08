"use client";
// The initiatives a project belongs to
// (docs/architecture/initiatives-projects-role-page.md I1, I2): one `in-N` pill
// each, the ones still open first. It sits under a project's lead on the
// project page and on a project's card in a role's scope view. Reads the store
// itself (the workspace's initiatives are fed once, by HostFeeders) and renders
// nothing when the project is in none. With `metrics`, each goal's first
// number stands beside its pill: the chip a goal's own row shows, or the line
// a card has room for.
import { useMemo } from "react";
import { metricReadings, metricTrends } from "@codecast/shared/contracts/initiative";
import { useInitiatives } from "../../hooks/useInitiatives";
import { initiativesOfProject } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";
import { MetricTile } from "./InitiativeAtoms";

export function ProjectInitiatives({ projectId, size = "sm", label, except, metrics, now, className }: {
  projectId: string;
  size?: "xs" | "sm";
  /** An initiative to leave out: its own page lists what a project shares with the others. */
  except?: string;
  /** Words before the pills, where the line stands alone ("Serves"). */
  label?: string;
  /** Show each goal's first number against its target beside its pill. */
  metrics?: "chip" | "line";
  /** The clock a line's date is read against; a chip shows no date. */
  now?: number;
  className?: string;
}) {
  const all = useInitiatives();
  const rows = useMemo(() => initiativesOfProject(all, projectId).filter((r) => r._id !== except), [all, projectId, except]);
  if (rows.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-x-1.5 gap-y-1 flex-wrap min-w-0", size === "xs" ? "text-[11px]" : "text-[12.5px]", className)} data-project-initiatives={projectId}>
      {label && <span style={{ color: "var(--sol-text-dim)" }}>{label}</span>}
      {rows.map((r) => {
        const reading = metrics ? metricReadings(r)[0] : undefined;
        return (
          <span key={r._id} className="inline-flex items-center gap-1.5 min-w-0 max-w-full" data-project-initiative={r.short_id || r._id}>
            <EntityIdPill type="initiative" id={r.short_id || r._id} />
            {reading && metrics && <MetricTile reading={reading} trend={metricTrends(r)[reading.key]} now={now ?? Date.now()} size={metrics} />}
          </span>
        );
      })}
    </span>
  );
}
