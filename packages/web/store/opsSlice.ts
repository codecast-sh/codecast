// Ops writes (docs/architecture/external-data.md X10). The ops collections are
// registered in clientSyncRegistry, which gives them their store slots,
// persistence and pending protection; this slice holds only the actions. Each
// one patches the draft so the page moves in the same tick, and rides
// `dispatch` to the side effect of the same name (convex/dispatch.ts), which
// calls the one public function the CLI also calls.
//
// A new source paints a stub carrying the viewer's workspace key, so it shows
// through the useWorkspaceCollection boundary at once. createSource takes no
// client key; the next listSources snapshot carries the real row and drops
// the stub, the issue sync sources' convergence.
import { action, asyncAction } from "./mutativeMiddleware";
import { activeWorkspaceKey } from "../lib/workspaceScope";
import type { GroupStatus, SourceProvider } from "@codecast/shared/contracts/ingest";

/** Writes are explicit: the caller names the workspace it is looking at. */
export type CreateOpsSourceInput = {
  name: string;
  provider: Extract<SourceProvider, "sdk" | "http">;
  workspace: "personal" | "team";
  team_id?: string;
};

/** What the server hands back once: the key is stored as a hash after this. */
export type CreatedOpsSource = { source_id: string; short_id: string; name: string; ingest_key: string | null };

export type OpsSliceActions = {
  setOpsGroupStatus: (groupId: string, status: GroupStatus) => void;
  setOpsSourceStatus: (sourceId: string, status: "active" | "paused") => void;
  removeOpsSource: (sourceId: string) => void;
  grantOpsAction: (sourceId: string, actionName: string) => void;
  revokeOpsAction: (sourceId: string, actionName: string) => void;
  createOpsSource: (input: CreateOpsSourceInput) => Promise<CreatedOpsSource | null>;
  rotateOpsSourceKey: (sourceId: string) => Promise<{ ingest_key: string; key_prefix: string | null } | null>;
};

// The middleware wraps an asyncAction so its CALLER receives the server
// result as a promise; the body returns nothing.
type OpsSliceImpl = Omit<OpsSliceActions, "createOpsSource" | "rotateOpsSourceKey"> & {
  createOpsSource: (input: CreateOpsSourceInput) => void;
  rotateOpsSourceKey: (sourceId: string) => void;
};

type OpsDraft = {
  opsSources: Record<string, any>;
  opsGroups: Record<string, any>;
  opsApps: Record<string, any>;
  currentUser?: { _id: string } | null;
};

export function createOpsSlice(): OpsSliceActions {
  const impl: OpsSliceImpl = {
    // Only `status` is written: it reconciles by value. The resolve stamps are
    // the server's, and a locked number that never matches would freeze.
    setOpsGroupStatus: action(function (this: OpsDraft, groupId: string, status: GroupStatus) {
      const row = this.opsGroups[groupId];
      if (row) row.status = status;
    }),

    setOpsSourceStatus: action(function (this: OpsDraft, sourceId: string, status: "active" | "paused") {
      const row = this.opsSources[sourceId];
      if (!row) return;
      row.status = status;
      // Resuming clears the reason it stopped, as updateSource does.
      if (status === "active") delete row.last_error;
    }),

    removeOpsSource: action(function (this: OpsDraft, sourceId: string) {
      delete this.opsSources[sourceId];
    }),

    // Grants are not locked (opsApps is not localFirst): the server stamps
    // who and when, so the echo replaces this entry rather than matching it.
    grantOpsAction: action(function (this: OpsDraft, sourceId: string, actionName: string) {
      const row = this.opsApps[sourceId];
      if (!row) return;
      const me = String(this.currentUser?._id ?? "");
      const kept = (row.grants ?? []).filter((g: any) => g.action !== actionName);
      row.grants = [...kept, { action: actionName, granted_by: me, granted_at: Date.now(), via: "session" }];
    }),

    revokeOpsAction: action(function (this: OpsDraft, sourceId: string, actionName: string) {
      const row = this.opsApps[sourceId];
      if (row) row.grants = (row.grants ?? []).filter((g: any) => g.action !== actionName);
    }),

    createOpsSource: asyncAction(function (this: OpsDraft, input: CreateOpsSourceInput) {
      const me = String(this.currentUser?._id ?? "");
      const name = input.name.trim().toLowerCase();
      if (!name || !me) return;
      const stubId = `temp_src_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      this.opsSources[stubId] = {
        _id: stubId,
        short_id: "",
        name,
        provider: input.provider,
        workspace: activeWorkspaceKey(input.workspace === "team" ? input.team_id : null, me) ?? undefined,
        team_id: input.workspace === "team" ? input.team_id : undefined,
        owner_user_id: me,
        keyed: true,
        status: "active",
        promote: ["new", "regressed"],
        events_today: 0,
        dropped_today: 0,
        groups_open: 0,
        created_at: now,
        updated_at: now,
      };
    }),

    // Nothing to paint: the new prefix is the server's to mint.
    rotateOpsSourceKey: asyncAction(function (this: OpsDraft, _sourceId: string) {}),
  };
  return impl as unknown as OpsSliceActions;
}
