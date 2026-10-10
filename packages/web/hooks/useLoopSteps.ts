"use client";
// The learning loop's front half for one project (docs/architecture/
// learning-loop.md LL1): expectations, observe, judge and problems, built from
// rows the line workspace already holds (its signals, causes and labels) plus
// the project's expectations. The workspace draws it as the leading "Find"
// band of the Graph and the Notebook, so a reader meets the loop where it
// starts rather than at "a problem comes in". Pure reads from the store; the
// only feeder mounted here is the project's expectations.
import { useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { LineFinderDecl } from "@codecast/shared/contracts/lineProfile";
import { buildLoopSteps, type LoopLabelRow, type LoopProblem, type LoopSignal, type LoopSteps } from "../lib/line/loopSteps";
import { useProjectExpectations, useSyncProjectExpectations } from "./useSyncProjectExpectations";

type LoopProject = { team_id?: string | null; line_profile?: { team?: string; finders?: LineFinderDecl[] } | null } | null;

export type LoopInputs = {
  projectId: string | null;
  project: LoopProject;
  signals: ReadonlyArray<LoopSignal>;
  problems: ReadonlyArray<LoopProblem>;
  labels: ReadonlyArray<LoopLabelRow>;
  viewerId: string | null;
  names: ReadonlyMap<string, string>;
  now: number;
};

/** The product's name as a reader says it ("Union"): its line profile's team, else the team the project belongs to. */
export function useProductName(project: LoopProject): string | null {
  const teamName = useInboxStore((s) => {
    const id = project?.team_id;
    const teams = (s as { teams?: Array<{ _id: string; name?: string }> }).teams;
    return id && Array.isArray(teams) ? teams.find((t) => t._id === id)?.name ?? null : null;
  });
  return project?.line_profile?.team?.trim() || teamName;
}

/** The loop's steps, or null until the project is known. */
export function useLoopSteps({ projectId, project, signals, problems, labels, viewerId, names, now }: LoopInputs): LoopSteps | null {
  useSyncProjectExpectations(projectId);
  const expRow = useProjectExpectations(projectId);
  const doc = expRow?.doc ?? null;
  const finders = project?.line_profile?.finders;
  const product = useProductName(project);
  return useMemo(() => {
    if (!projectId) return null;
    return buildLoopSteps({
      signals,
      finders,
      expectations: doc ? { version: doc.version, items: doc.items } : null,
      problems,
      labels,
      viewerId,
      names,
      product,
      now,
    });
  }, [projectId, signals, finders, doc, problems, labels, viewerId, names, product, now]);
}
