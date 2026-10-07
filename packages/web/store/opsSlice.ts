// Ops writes (docs/architecture/external-data.md X10). The ops collections are
// registered in clientSyncRegistry, which gives them their store slots,
// persistence and pending protection; this slice holds only the actions. Each
// one patches the draft so the page moves in the same tick, and rides
// `dispatch` to the side effect of the same name (convex/dispatch.ts), which
// calls the one public function the CLI also calls.
//
// A new source paints a stub carrying the viewer's workspace key, so it shows
// through the useWorkspaceCollection boundary at once. A source's name is
// unique in its workspace, so opsSources' altKey on `name` supersedes the stub
// onto the server row the moment listSources carries it.
import { action, asyncAction } from "./mutativeMiddleware";
import { activeWorkspaceKey } from "../lib/workspaceScope";
import { KEYED_SOURCE_PROVIDERS, normalizeSourceName, type GroupStatus, type SourceProvider } from "@codecast/shared/contracts/ingest";
import { DEFAULT_REPLAY_BACKFILL_WINDOW, replayBackfillResumes, replayBackfillSince, type ReplayBackfill, type ReplayBackfillWindow } from "@codecast/shared/contracts/replay";

/** Writes are explicit: the caller names the workspace it is looking at. */
export type CreateOpsSourceInput = {
  name: string;
  /** sdk and http mint a key; sentry, posthog and app read through the workspace's connection. */
  provider: Extract<SourceProvider, "sdk" | "http" | "sentry" | "posthog" | "app">;
  /** Narrows a vendor source (Sentry project slugs); the connection names the rest. */
  config?: { projects?: string[] };
  /** app only: where the app answers. Makes the workspace's signed app connection in the same step. */
  base_url?: string;
  workspace: "personal" | "team";
  team_id?: string;
};

/** What the server hands back once: the key is stored as a hash after this. */
export type CreatedOpsSource = { source_id: string; short_id: string; name: string; workspace?: string; ingest_key: string | null };

export type OpsSliceActions = {
  setOpsGroupStatus: (groupId: string, status: GroupStatus) => void;
  setOpsSourceStatus: (sourceId: string, status: "active" | "paused") => void;
  /** Import every recording a PostHog or Sentry source still keeps; a stopped import continues where it was. */
  startOpsReplayImport: (sourceId: string, window?: ReplayBackfillWindow) => void;
  stopOpsReplayImport: (sourceId: string) => void;
  /** Read the past values a watch's source already holds into it now (metrics.loadHistory). */
  loadOpsWatchHistory: (watchId: string) => void;
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
  opsSamples: Record<string, any>;
  opsApps: Record<string, any>;
  opsWatches: Record<string, any>;
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

    // The progress is the server's (opsSources leaves replay_backfill
    // unprotected): this paints "importing" now, the first echo the truth.
    // Resuming keeps the counts, as replayBackfill.start does.
    startOpsReplayImport: action(function (this: OpsDraft, sourceId: string, window?: ReplayBackfillWindow) {
      const row = this.opsSources[sourceId];
      if (!row) return;
      const now = Date.now();
      const prev: ReplayBackfill | undefined = row.replay_backfill;
      const w = window ?? prev?.window ?? DEFAULT_REPLAY_BACKFILL_WINDOW;
      if (prev && replayBackfillResumes(prev, now) && w === prev.window) {
        row.replay_backfill = { ...prev, status: "running", failures_in_row: 0, rate_limited_since: undefined, last_error: undefined, started_at: now, updated_at: now };
        return;
      }
      if (prev?.status === "running") return;
      const since = replayBackfillSince(w, now);
      row.replay_backfill = { status: "running", window: w, ...(since !== undefined ? { since } : {}), until: now, listed: 0, imported: 0, skipped: 0, failed: 0, started_at: now, updated_at: now };
    }),

    stopOpsReplayImport: action(function (this: OpsDraft, sourceId: string) {
      const b = this.opsSources[sourceId]?.replay_backfill;
      if (b?.status === "running") Object.assign(b, { status: "paused", last_error: "Stopped", updated_at: Date.now() });
    }),

    // The same mark metrics.loadHistory writes: "reading" until the read lands.
    loadOpsWatchHistory: action(function (this: OpsDraft, watchId: string) {
      const row = this.opsWatches[watchId];
      if (!row) return;
      row.history = { at: Date.now(), added: 0, reading: true };
    }),

    // The server purges the source's groups and samples (ingest.purgeSourceRows),
    // so they leave here too: no list, badge or count keeps them.
    removeOpsSource: action(function (this: OpsDraft, sourceId: string) {
      delete this.opsSources[sourceId];
      for (const [id, g] of Object.entries(this.opsGroups)) if (g?.source_id === sourceId) delete this.opsGroups[id];
      for (const [id, x] of Object.entries(this.opsSamples ?? {})) if (x?.source_id === sourceId) delete this.opsSamples[id];
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
      const name = normalizeSourceName(input.name);
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
        keyed: KEYED_SOURCE_PROVIDERS.includes(input.provider),
        ...(input.config ? { config: input.config } : {}),
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
