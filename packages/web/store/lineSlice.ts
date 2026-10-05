// Line profile writes (plan pl-838). A project's line profile lives in its
// repo's `.codecast/line.toml`; projects.line_profile is the copy the daemon
// publishes from it, and only a publish writes that copy. An edit is a
// sessionCommands row (lib/sessionCommands), painted here on the click and
// riding `dispatch` to the side effect of the same name (convex/dispatch.ts
// editLineProfile), which hands it to the daemon on the machine holding the
// checkout under the row's request id. The daemon's answer, and later its
// report of the republish, settle the row through sessionCommands.results in
// every window, whichever page is open. The page shows the published copy
// with the rows still travelling laid over it (lib/lineSettings
// liveLineProfile), so a refusal or a lost machine takes nothing back from
// the project row: the row simply stops counting.
import { asyncAction } from "./mutativeMiddleware";
import { stampSessionCommand } from "./sessionCommandStamp";
import type { LineProfileEdit } from "@codecast/shared/contracts/lineProfile";
import { editKey } from "../lib/lineSettings";

export type LineSliceActions = {
  editLineProfile: (requestId: string, projectId: string, edits: LineProfileEdit[]) => Promise<{ command_id: string } | null | undefined>;
};

export function createLineSlice(): LineSliceActions {
  return {
    editLineProfile: asyncAction(function (this: { sessionCommands: Record<string, any> }, requestId: string, projectId: string, edits: LineProfileEdit[]) {
      stampSessionCommand(this, {
        _id: requestId, command: "line_profile_edit", kind: "line_edit",
        project_id: projectId, edits: structuredClone(edits), keys: edits.map(editKey),
      });
    }) as LineSliceActions["editLineProfile"],
  };
}
