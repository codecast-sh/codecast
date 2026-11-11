// The one list of artifact products. A product registers by adding its spec
// here; every client and the server read kinds, describe and verbs from it.
import type { ArtifactSpec, ArtifactType } from "./spec";
import { boardSpec } from "./board";
import { sheetSpec } from "./sheet";
import { dashboardSpec } from "./dashboard";

export const ARTIFACT_SPECS: Record<ArtifactType, ArtifactSpec> = {
  board: boardSpec,
  sheet: sheetSpec,
  dashboard: dashboardSpec,
};

export function artifactSpec(type: ArtifactType): ArtifactSpec {
  return ARTIFACT_SPECS[type];
}

/** The spec a CLI group names (`board`, `sheet`, `data`). */
export function specForCli(cli: string): ArtifactSpec | undefined {
  return Object.values(ARTIFACT_SPECS).find((s) => s.cli === cli);
}
