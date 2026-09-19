"use client";
// The initiatives a project belongs to
// (docs/architecture/initiatives-projects-role-page.md I1, I2): one `in-N` pill
// each, the ones still open first. It sits under a project's lead on the
// project page and on a project's card in a role's scope view. Reads the store
// itself (the workspace's initiatives are fed once, by HostFeeders) and renders
// nothing when the project is in none.
import { useMemo } from "react";
import { useInitiatives } from "../../hooks/useInitiatives";
import { initiativesOfProject } from "../../lib/initiatives";
import { cn } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";

export function ProjectInitiatives({ projectId, size = "sm", label, except, className }: {
  projectId: string;
  size?: "xs" | "sm";
  /** An initiative to leave out: its own page lists what a project shares with the others. */
  except?: string;
  /** Words before the pills, where the line stands alone ("Part of"). */
  label?: string;
  className?: string;
}) {
  const all = useInitiatives();
  const rows = useMemo(() => initiativesOfProject(all, projectId).filter((r) => r._id !== except), [all, projectId, except]);
  if (rows.length === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-x-1.5 gap-y-1 flex-wrap min-w-0", size === "xs" ? "text-[11px]" : "text-[12.5px]", className)} data-project-initiatives={projectId}>
      {label && <span style={{ color: "var(--sol-text-dim)" }}>{label}</span>}
      {rows.map((r) => <EntityIdPill key={r._id} type="initiative" id={r.short_id || r._id} />)}
    </span>
  );
}
