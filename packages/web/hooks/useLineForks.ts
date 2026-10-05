"use client";
// Customized lines by workflow slug (plan pl-838): every project in the
// workspace has one possible fork slug (lineForkSlug), so a run's or a role's
// slug names the project whose copy it is. Wakes only when a project's id,
// short id or title moves.
import { useMemo } from "react";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { lineForkIndex } from "../lib/line/lineStations";

export type LineForkProject = { _id: string; short_id?: string | null; title?: string | null };

const sig = (p: LineForkProject) => `${p.short_id ?? ""}|${p.title ?? ""}`;

export function useLineForks(): ReadonlyMap<string, LineForkProject> {
  const projects = useWorkspaceCollection<LineForkProject>("projects", sig);
  return useMemo(() => lineForkIndex(projects), [projects]);
}
