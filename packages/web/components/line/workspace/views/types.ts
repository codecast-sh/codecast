// What every view of the line workspace receives (docs/architecture/line-workspace.md
// LW1): the one model, the shared selection and the way to change it. A view
// reads the model and selects through `select`; the step drawer, the header
// and the URL follow. Widgets inside a view open steps and runs through
// useLineNav(), which the shell points at the same selection.
import type { LineModel } from "../../../../lib/line/lineModel";
import type { LineSelection, LineSelectionPatch } from "../../../../lib/line/lineWorkspaceUrl";
import type { LineSelect, LineWorkspace } from "../../../../hooks/useLineWorkspace";

export type LineViewProps = {
  model: LineModel;
  workspace: LineWorkspace;
  selection: LineSelection;
  /** Change the selection; `runCase` names a run's case so the case moves with it. A move to another place is a
   *  history entry; `{ replace: true }` rewrites the current one (a keyboard cursor, the app's own fix-up). */
  select: LineSelect;
  /** The address of a selection, for real links. */
  href: (patch: LineSelectionPatch, runCase?: string | null) => string;
  /** The step drawer is open over the view (it takes the arrow keys then). */
  drawerOpen?: boolean;
  /** The app is pinned to one project (its page's Line tab): nothing in it changes the project filter. */
  pinned?: boolean;
};
