// What every view of the line workspace receives (docs/architecture/line-workspace.md
// LW1): the one model, the shared selection and the way to change it. A view
// reads the model and selects through `select`; the step drawer, the header
// and the URL follow. Widgets inside a view open steps and runs through
// useLineNav(), which the shell points at the same selection.
import type { LineModel } from "../../../../lib/line/lineModel";
import type { LineSelection, LineSelectionPatch } from "../../../../lib/line/lineWorkspaceUrl";
import type { LineWorkspace } from "../../../../hooks/useLineWorkspace";

export type LineViewProps = {
  model: LineModel;
  workspace: LineWorkspace;
  selection: LineSelection;
  /** Change the selection; `runCase` names a run's case so the case moves with it. */
  select: (patch: LineSelectionPatch, runCase?: string | null) => void;
  /** The address of a selection, for real links. */
  href: (patch: LineSelectionPatch, runCase?: string | null) => string;
};
