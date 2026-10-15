"use client";
// The product's name as a reader says it ("Union"), for "runs in Union" and
// "Fixes in Union": its line profile's team, else the project's team.
import { useInboxStore } from "../store/inboxStore";
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";

type LoopProject = { team_id?: string | null; line_profile?: { team?: string; finders?: LineFinderDecl[] } | null } | null;

/** The product's name as a reader says it ("Union"): its line profile's team, else the team the project belongs to. */
export function useProductName(project: LoopProject): string | null {
  const teams = useInboxStore((s) => (s as { teams?: TeamRow[] }).teams);
  return productName(project, teams);
}

type TeamRow = { _id: string; name?: string };

/** The product's name as a reader says it ("Union"): the line profile's team, else the project's team's name. */
export function productName(project: LoopProject, teams: ReadonlyArray<TeamRow> | undefined): string | null {
  const id = project?.team_id;
  const teamName = id && Array.isArray(teams) ? teams.find((t) => t._id === id)?.name ?? null : null;
  return project?.line_profile?.team?.trim() || teamName;
}
