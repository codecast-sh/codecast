// Each vehicle's glyph on a change's chip, row and journey (docs/architecture/changes.md CH3).
import { GitBranch, GitCommitHorizontal, GitPullRequest, Layers, type LucideIcon } from "lucide-react";
import type { ChangeVehicle } from "./lifecycle";

export const VEHICLE_GLYPH: Record<ChangeVehicle["kind"], LucideIcon> = {
  branch: GitBranch,
  pr: GitPullRequest,
  commit: GitCommitHorizontal,
  pass: Layers,
};

/** Names that are code (a branch, a sha, a number) read in the code face; a session's title does not. */
export const MONO_VEHICLE: Record<ChangeVehicle["kind"], boolean> = { branch: true, pr: true, commit: true, pass: false };
