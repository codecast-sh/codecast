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
import { normalizeNotify, type AlertNotifyInput } from "@codecast/shared/contracts/metricMonitor";
import { DEFAULT_REPLAY_BACKFILL_WINDOW, replayBackfillResumes, replayBackfillSince, type ReplayBackfill, type ReplayBackfillWindow } from "@codecast/shared/contracts/replay";

/** A group's resolve stamps as an undo puts them back; null is "had none". */
export type OpsGroupResolveStamps = {
  resolved_at: number | null;
  resolved_in: string | null;
  /** Who resolved it, put back only when the row carried it (a server that stamps it). */
  resolved_via?: "person" | "recovered" | "vendor" | null;
  resolved_by?: string | null;
};

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

export type OpsWatchPatch = {
  name?: string; query?: string; threshold?: number | null; direction?: "above" | "below"; unit?: string | null; interval_ms?: number; status?: "active" | "paused";
  /** The monitor (shared/contracts/metricMonitor.ts); null takes a setting off. */
  eval_reads?: number | null; warn?: number | null; no_data_after?: number | null; muted_until?: number | null;
  /** What its alert does; null goes back to the source's rule. */
  on_alert?: "task" | "timeline" | null;
  /** Who else the alert reaches (contracts/metricMonitor AlertNotify); null clears it. The server stores the caller as its `by`. */
  notify?: AlertNotifyInput | null;
};

export type CreateOpsWatchInput = { source: string; name: string; query_kind: "hogql" | "insight" | "reader" | "volume"; query: string; threshold?: number; direction?: "above" | "below"; unit?: string; interval_ms?: number; eval_reads?: number; warn?: number; no_data_after?: number };

/** What the server hands back once: the key is stored as a hash after this. */
export type CreatedOpsSource = { source_id: string; short_id: string; name: string; workspace?: string; ingest_key: string | null };

export type OpsSliceActions = {
  /** `restore` is an undo: the resolve stamps the group held before the gesture it takes back (ingest.setGroupStatus). */
  setOpsGroupStatus: (groupId: string, status: GroupStatus, restore?: OpsGroupResolveStamps) => void;
  /** Record the fix session started on a group from its page (ingest.setGroupFix). */
  setOpsGroupFix: (groupId: string, conversationId: string) => void;
  /** Re-point a group at its real problem task, or unlink a misfiled one with null (ingest.setGroupTask). */
  setOpsGroupTask: (groupId: string, taskId: string | null) => void;
  setOpsSourceStatus: (sourceId: string, status: "active" | "paused") => void;
  /** The project a source belongs to (ingest.updateSource `project`): where its fixes run and which ships can move it; null detaches it. */
  setOpsSourceProject: (sourceId: string, projectId: string | null) => void;
  /** Import every recording a PostHog or Sentry source still keeps; a stopped import continues where it was. */
  startOpsReplayImport: (sourceId: string, window?: ReplayBackfillWindow) => void;
  stopOpsReplayImport: (sourceId: string) => void;
  /** Read the past values a watch's source already holds into it now (metrics.loadHistory). */
  loadOpsWatchHistory: (watchId: string) => void;
  /** Poll watches now rather than at their next check (metrics.readNow); nothing to paint until the read lands. */
  readOpsWatchesNow: (watchIds: string[]) => void;
  /** A watch's line (null takes it off), side, unit, interval, name or pause (metrics.updateWatch). */
  updateOpsWatch: (watchId: string, patch: OpsWatchPatch) => void;
  removeOpsWatch: (watchId: string) => void;
  /** A new watch; its id is the server's to mint, so the caller awaits it to open the watch. */
  createOpsWatch: (input: CreateOpsWatchInput) => Promise<{ watch_id: string; short_id: string } | null>;
  removeOpsSource: (sourceId: string) => void;
  grantOpsAction: (sourceId: string, actionName: string) => void;
  revokeOpsAction: (sourceId: string, actionName: string) => void;
  setOpsAppWatchPaused: (sourceId: string, watchKey: string, paused: boolean) => void;
  pollOpsAppWatch: (sourceId: string, watchKey: string) => void;
  createOpsSource: (input: CreateOpsSourceInput) => Promise<CreatedOpsSource | null>;
  /** A new ingest key; the old one keeps working a day unless `endOld` (ingest.rotateKey). */
  rotateOpsSourceKey: (sourceId: string, endOld?: boolean) => Promise<{ ingest_key: string; key_prefix: string | null } | null>;
  /** Stop accepting a rotated-out key before its grace window ends (ingest.endOldKey). */
  endOpsSourceOldKey: (sourceId: string) => void;
};

// The middleware wraps an asyncAction so its CALLER receives the server
// result as a promise; the body returns nothing.
type OpsSliceImpl = Omit<OpsSliceActions, "createOpsSource" | "rotateOpsSourceKey" | "createOpsWatch"> & {
  createOpsSource: (input: CreateOpsSourceInput) => void;
  createOpsWatch: (input: CreateOpsWatchInput) => void;
  rotateOpsSourceKey: (sourceId: string, endOld?: boolean) => void;
};

type OpsDraft = {
  opsSources: Record<string, any>;
  opsGroups: Record<string, any>;
  opsSamples: Record<string, any>;
  opsApps: Record<string, any>;
  opsWatches: Record<string, any>;
  opsReplays?: Record<string, any>;
  currentUser?: { _id: string } | null;
};

export function createOpsSlice(): OpsSliceActions {
  const impl: OpsSliceImpl = {
    // Only `status` is written: it reconciles by value. The resolve stamps are
    // the server's, and a locked number that never matches would freeze.
    // An undo's restored stamps are the exact values the server writes back,
    // so they paint now and the echo matches them.
    setOpsGroupStatus: action(function (this: OpsDraft, groupId: string, status: GroupStatus, restore?: OpsGroupResolveStamps) {
      const row = this.opsGroups[groupId];
      if (!row) return;
      row.status = status;
      if (restore) {
        if (restore.resolved_at === null) delete row.resolved_at;
        else row.resolved_at = restore.resolved_at;
        if (restore.resolved_in === null) delete row.resolved_in;
        else row.resolved_in = restore.resolved_in;
        for (const k of ["resolved_via", "resolved_by"] as const) {
          if (restore[k] === undefined) continue;
          if (restore[k] === null) delete row[k];
          else row[k] = restore[k];
        }
      }
    }),

    // The stamp is the server's; the id reconciles by value.
    setOpsGroupFix: action(function (this: OpsDraft, groupId: string, conversationId: string) {
      const row = this.opsGroups[groupId];
      if (row) row.fix_conversation_id = conversationId;
    }),

    // The task id reconciles by value; null unlinks.
    setOpsGroupTask: action(function (this: OpsDraft, groupId: string, taskId: string | null) {
      const row = this.opsGroups[groupId];
      if (!row) return;
      if (taskId) row.signal_task_id = taskId;
      else delete row.signal_task_id;
    }),

    setOpsSourceStatus: action(function (this: OpsDraft, sourceId: string, status: "active" | "paused") {
      const row = this.opsSources[sourceId];
      if (!row) return;
      row.status = status;
      // Resuming clears the reason it stopped, as updateSource does.
      if (status === "active") delete row.last_error;
    }),

    // The id reconciles by value: updateSource stores the project the id names.
    setOpsSourceProject: action(function (this: OpsDraft, sourceId: string, projectId: string | null) {
      const row = this.opsSources[sourceId];
      if (!row) return;
      if (projectId) row.project_id = projectId;
      else delete row.project_id;
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

    // The poll's answer lands on the row (value or error); nothing is guessed here.
    readOpsWatchesNow: action(function (this: OpsDraft, _watchIds: string[]) {}),

    // Every field written here is one the server stores as given (cleaned the
    // same way), so the echo matches it. The alert state is the next poll's,
    // which updateWatch makes due at once when the line or its side moves.
    updateOpsWatch: action(function (this: OpsDraft, watchId: string, patch: OpsWatchPatch) {
      const row = this.opsWatches[watchId];
      if (!row) return;
      if (patch.name !== undefined && patch.name.trim()) row.name = patch.name.trim();
      if (patch.query !== undefined && patch.query.trim()) row.query = patch.query.trim();
      if (patch.threshold === null) {
        delete row.threshold;
        delete row.warn;
        row.state = "ok";
      } else if (patch.threshold !== undefined) row.threshold = patch.threshold;
      // The monitor, written as metrics.updateWatch stores it: one read is the default, a mute in the past is none.
      if (patch.eval_reads !== undefined) {
        if (patch.eval_reads === null || patch.eval_reads <= 1) delete row.eval_reads;
        else row.eval_reads = patch.eval_reads;
      }
      for (const k of ["warn", "no_data_after"] as const) {
        if (patch[k] === null) delete row[k];
        else if (patch[k] !== undefined) row[k] = patch[k];
      }
      if (patch.muted_until !== undefined) {
        if (patch.muted_until === null || patch.muted_until <= Date.now()) delete row.muted_until;
        else row.muted_until = patch.muted_until;
      }
      if (patch.on_alert === null) delete row.on_alert;
      else if (patch.on_alert !== undefined) row.on_alert = patch.on_alert;
      if (patch.notify !== undefined) {
        // Stored the way metrics.updateWatch stores it (normalizeNotify), so the echo matches.
        const next = normalizeNotify(patch.notify, String(this.currentUser?._id ?? ""));
        if (next) row.notify = next;
        else delete row.notify;
      }
      if (patch.direction) row.direction = patch.direction;
      if (patch.unit === null || patch.unit === "") delete row.unit;
      else if (patch.unit !== undefined) row.unit = patch.unit.trim().slice(0, 12);
      if (patch.interval_ms !== undefined) row.interval_ms = patch.interval_ms;
      if (patch.status) {
        row.status = patch.status;
        if (patch.status === "active") delete row.last_error;
      }
    }),

    // Its group and the transitions it announced stay as history (metrics.removeWatch).
    removeOpsWatch: action(function (this: OpsDraft, watchId: string) {
      delete this.opsWatches[watchId];
    }),

    // Nothing to paint: the short id and the first value are the server's.
    createOpsWatch: asyncAction(function (this: OpsDraft, _input: CreateOpsWatchInput) {}),

    // The server purges the source's groups and samples (ingest.purgeSourceRows),
    // so they leave here too: no list, badge or count keeps them.
    removeOpsSource: action(function (this: OpsDraft, sourceId: string) {
      delete this.opsSources[sourceId];
      for (const [id, g] of Object.entries(this.opsGroups)) if (g?.source_id === sourceId) delete this.opsGroups[id];
      for (const [id, x] of Object.entries(this.opsSamples ?? {})) if (x?.source_id === sourceId) delete this.opsSamples[id];
      // Its watches and replays go in the same purge.
      for (const [id, w] of Object.entries(this.opsWatches ?? {})) if (w?.source_id === sourceId) delete this.opsWatches[id];
      for (const [id, r] of Object.entries(this.opsReplays ?? {})) if (r?.source_id === sourceId) delete this.opsReplays![id];
    }),

    // Grants live on the source's row and are not locked (`grants` is an
    // unprotected field): the server stamps who and when, so the echo
    // replaces this entry rather than matching it.
    grantOpsAction: action(function (this: OpsDraft, sourceId: string, actionName: string) {
      const row = this.opsSources[sourceId];
      if (!row) return;
      const me = String(this.currentUser?._id ?? "");
      const kept = (row.grants ?? []).filter((g: any) => g.action !== actionName);
      row.grants = [...kept, { action: actionName, granted_by: me, granted_at: Date.now(), via: "session" }];
    }),

    revokeOpsAction: action(function (this: OpsDraft, sourceId: string, actionName: string) {
      const row = this.opsSources[sourceId];
      if (row) row.grants = (row.grants ?? []).filter((g: any) => g.action !== actionName);
    }),

    // An app watch's pause lives on its watch_state entry, as sources/app.ts setWatchPaused writes it.
    setOpsAppWatchPaused: action(function (this: OpsDraft, sourceId: string, watchKey: string, paused: boolean) {
      const row = this.opsSources[sourceId];
      if (!row) return;
      const state = [...(row.watch_state ?? [])];
      const i = state.findIndex((w: any) => w.key === watchKey);
      const prev = i >= 0 ? { ...state[i] } : { key: watchKey, polled_at: 0 };
      delete prev.paused;
      const next = paused ? { ...prev, paused: true } : prev;
      if (i >= 0) state[i] = next;
      else state.push(next);
      row.watch_state = state;
    }),

    // A poll now: nothing to paint until it lands, when the watch's polled_at moves on the source row.
    pollOpsAppWatch: action(function (this: OpsDraft, _sourceId: string, _watchKey: string) {}),

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
    rotateOpsSourceKey: asyncAction(function (this: OpsDraft, _sourceId: string, _endOld?: boolean) {}),

    endOpsSourceOldKey: action(function (this: OpsDraft, sourceId: string) {
      const row = this.opsSources[sourceId];
      if (!row) return;
      delete row.old_key_until;
      delete row.old_key_prefix;
    }),
  };
  return impl as unknown as OpsSliceActions;
}
