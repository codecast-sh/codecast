// External data on the Ops page (docs/architecture/external-data.md X10): the
// feeders that hand each live query to its store collection, and the readers
// the page paints from. Every collection is registered in
// store/clientSyncRegistry.ts; nothing under app/ or components/ subscribes to
// these queries directly.
import { useEffect, useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { GROUP_RULES } from "@codecast/shared/contracts/ingest";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import type { SyncOpts } from "../store/inboxStore";
import { useSyncCollection, type SyncCollectionResult } from "./useSyncCollection";
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { useCollectionRows } from "./useCollectionRows";
import type { OpsApp, OpsAppCall, OpsEvent, OpsGroup, OpsReplay, OpsReplayTimeline, OpsSample, OpsSource, OpsWatch } from "../components/ops/opsTypes";

const api = _api as any;

/** How far back the lists reach: enough for the page, bounded for the wire. */
export const OPS_LIST_LIMIT = { groups: 200, events: 200, replays: 100, calls: 100 } as const;

/**
 * The active workspace as the ingest functions take it, without the project
 * path: Ops reads the whole workspace, never one project of it.
 */
export function useOpsScope(): { workspace: "team"; team_id: string } | { workspace: "personal" } | "skip" {
  const ws = useWorkspaceArgs();
  const stamp = workspaceStamp(ws);
  const teamId = "team_id" in stamp ? String(stamp.team_id) : undefined;
  return useMemo(() => (ws === "skip" ? "skip" : teamId ? { workspace: "team" as const, team_id: teamId } : { workspace: "personal" as const }), [ws === "skip", teamId]); // eslint-disable-line react-hooks/exhaustive-deps
}

function withScope<T extends object>(scope: ReturnType<typeof useOpsScope>, args: T): any {
  return scope === "skip" ? "skip" : { ...scope, ...args };
}

// ── What a list answer vouches for ──

/**
 * The prune one answer of a bounded, newest-first window may make. opsGroups
 * and opsReplays are delta collections, because an opened row's detail must
 * survive a list that does not carry it, so without this a row the server
 * deleted (a removed source's groups) would stay cached and listed forever.
 * A full page vouches for the scope's rows newer than its oldest row (ties at
 * that edge may sit past the page, so they are kept); a short page vouches for
 * the whole scope. Only rows keyed by a server id are pruned.
 */
export function windowPrune<T>(rows: T[], limit: number, at: (row: T) => number, inScope: (row: T) => boolean): SyncOpts {
  const floor = rows.length >= limit ? Math.min(...rows.map(at)) : -Infinity;
  return { pruneAbsentScope: (row: any) => isConvexId(String(row?._id ?? "")) && inScope(row) && at(row) > floor };
}

/**
 * A workspace list's window. Its scope is the workspace the answer was read
 * by, which every row carries, so a cached row of another workspace is never
 * touched. An empty answer vouches for nothing: a prune plants a durable
 * tombstone, and an empty list is also what a reader can see for a beat
 * before its identity settles.
 */
export function workspaceWindowPrune<T extends { workspace?: string }>(limit: number, at: (row: T) => number) {
  return (rows: T[] | null | undefined): SyncOpts | undefined => {
    const workspace = Array.isArray(rows) ? rows[0]?.workspace : undefined;
    return workspace ? windowPrune(rows!, limit, at, (r) => r.workspace === workspace) : undefined;
  };
}

const groupsWindow = { syncOpts: workspaceWindowPrune<OpsGroup>(OPS_LIST_LIMIT.groups, (g) => g.last_seen) };
const replaysWindow = { syncOpts: workspaceWindowPrune<OpsReplay>(OPS_LIST_LIMIT.replays, (r) => r.started_at) };

/**
 * A detail feeder's answer that the row is gone for this reader: the server
 * refused it (null), or its lookup threw NOT_FOUND (ingest.groupByRef). Any
 * other error is a failed read, and the cached row stands.
 */
export function detailGone(feed: Pick<SyncCollectionResult, "refused" | "error">): boolean {
  if (feed.refused) return true;
  const data = (feed.error as { data?: unknown } | undefined)?.data;
  return !!data && typeof data === "object" && (data as { code?: unknown }).code === "NOT_FOUND";
}

/** Drop one cached row the server says is gone, with a durable tombstone; its _id, if it was cached. */
function dropGoneRow(key: "opsGroups" | "opsReplays", ref: string): string | null {
  const st = useInboxStore.getState();
  const row = byRef(Object.values(((st as any)[key] ?? {}) as Record<string, { _id: string; short_id?: string }>), ref);
  if (!row) return null;
  st.syncTable(key, [], { isDelta: true, pruneAbsentScope: (r: any) => r._id === row._id });
  return row._id;
}

// ── Feeders ──

export function useSyncOpsSources() {
  const scope = useOpsScope();
  return useSyncCollection("opsSources", api.ingest.listSources, withScope(scope, {}));
}

export function useSyncOpsGroups() {
  const scope = useOpsScope();
  const args = useMemo(() => withScope(scope, { limit: OPS_LIST_LIMIT.groups }), [scope]);
  return useSyncCollection("opsGroups", api.ingest.listGroups, args, groupsWindow);
}

export function useSyncOpsEvents() {
  const scope = useOpsScope();
  const args = useMemo(() => withScope(scope, { limit: OPS_LIST_LIMIT.events }), [scope]);
  return useSyncCollection("opsEvents", api.ingest.listEvents, args);
}

export function useSyncOpsReplays() {
  const scope = useOpsScope();
  const args = useMemo(() => withScope(scope, { limit: OPS_LIST_LIMIT.replays }), [scope]);
  return useSyncCollection("opsReplays", api.replays.list, args, replaysWindow);
}

export function useSyncOpsWatches() {
  const scope = useOpsScope();
  return useSyncCollection("opsWatches", api.metrics.listWatches, withScope(scope, {}));
}

// The source rides opsSources, its one home; the row is the group alone.
const groupRow = (d: any) => (d?.group ? [d.group] : []);
const sampleRows = (d: any) => d?.samples ?? [];
/** An answer holds its group's newest samples, so it vouches for that group's. */
export const groupSamplesPrune = (d: any): SyncOpts | undefined =>
  d?.group?._id ? windowPrune<OpsSample>(d.samples ?? [], GROUP_RULES.samples_per_group, (s) => s.at, (s) => s.group_id === d.group._id) : undefined;
const samplesFeed = { select: sampleRows, syncOpts: groupSamplesPrune };

/**
 * One group by its short id (eg-N) or _id: the row into opsGroups and its
 * samples into opsSamples. Two subscriptions on the same query and args are
 * one subscription on the wire. A group the server no longer has (its source
 * was removed) leaves the cache with its samples, so no list or count keeps it.
 */
export function useSyncOpsGroup(ref: string | null) {
  const args = ref ? { group: ref } : "skip";
  const group = useSyncCollection("opsGroups", api.ingest.getGroup, args, { select: groupRow });
  useSyncCollection("opsSamples", api.ingest.getGroup, args, samplesFeed);
  const gone = detailGone(group);
  useEffect(() => {
    if (!gone || !ref) return;
    const id = dropGoneRow("opsGroups", ref);
    if (id) useInboxStore.getState().syncTable("opsSamples", [], { isDelta: true, pruneAbsentScope: (s: any) => s.group_id === id });
  }, [gone, ref]);
  return group;
}

const replayRow = (d: any) => {
  if (!d) return [];
  const { groups: _g, timeline_md: _t, timeline_at: _at, ...row } = d;
  return [row];
};
const replayTimeline = (d: any) => (d ? [{ _id: d._id, groups: d.groups ?? [], timeline_md: d.timeline_md ?? null, timeline_at: d.timeline_at ?? null }] : []);
export function useSyncOpsReplay(ref: string | null) {
  const args = ref ? { replay: ref } : "skip";
  const replay = useSyncCollection("opsReplays", api.replays.get, args, { select: replayRow });
  useSyncCollection("opsReplayTimelines", api.replays.get, args, { select: replayTimeline });
  const gone = detailGone(replay);
  useEffect(() => {
    if (gone && ref) dropGoneRow("opsReplays", ref);
  }, [gone, ref]);
  return replay;
}

const appRow = (d: any) => (d?.source?._id ? [{ ...d, _id: String(d.source._id) }] : []);

/** One app source's manifest, grants and call audit. */
export function useSyncOpsApp(sourceId: string | null) {
  const scope = useOpsScope();
  const ok = !!sourceId && isConvexId(sourceId);
  const capArgs = useMemo(() => (ok ? withScope(scope, { source: sourceId }) : "skip"), [scope, ok, sourceId]);
  const callArgs = useMemo(() => (ok ? withScope(scope, { source: sourceId, limit: OPS_LIST_LIMIT.calls }) : "skip"), [scope, ok, sourceId]);
  const caps = useSyncCollection("opsApps", api.sources.app.capabilities, capArgs, { select: appRow });
  useSyncCollection("opsAppCalls", api.sources.app.listCalls, callArgs);
  return caps;
}

// ── Readers ──

const sourceSig = (s: OpsSource) => `${s.updated_at}|${s.status}|${s.short_id}|${s.last_event_at ?? 0}|${s.groups_open ?? 0}`;
const groupSig = (g: OpsGroup) => `${g.updated_at}|${g.status}|${g.count}|${g.last_seen}|${g.signal_task_id ?? ""}`;
const eventSig = (e: OpsEvent) => `${e.created_at}`;
const replaySig = (r: OpsReplay) => `${r.updated_at}|${r.chunks}|${r.has_timeline ? 1 : 0}`;
const watchSig = (w: OpsWatch) => `${w.updated_at}|${w.state}|${w.last_at ?? 0}|${w.status}`;

const byNewest = <T,>(at: (row: T) => number) => (a: T, b: T) => at(b) - at(a);

export function useOpsSources(): OpsSource[] {
  const rows = useWorkspaceCollection<OpsSource>("opsSources", sourceSig);
  return useMemo(() => [...rows].sort((a, b) => a.name.localeCompare(b.name)), [rows]);
}

export function useOpsGroups(): OpsGroup[] {
  const rows = useWorkspaceCollection<OpsGroup>("opsGroups", groupSig);
  return useMemo(() => [...rows].sort(byNewest((g) => g.last_seen)), [rows]);
}

export function useOpsEvents(): OpsEvent[] {
  const rows = useWorkspaceCollection<OpsEvent>("opsEvents", eventSig);
  return useMemo(() => [...rows].sort(byNewest((e) => e.created_at ?? 0)), [rows]);
}

export function useOpsReplays(): OpsReplay[] {
  const rows = useWorkspaceCollection<OpsReplay>("opsReplays", replaySig);
  return useMemo(() => [...rows].sort(byNewest((r) => r.started_at)), [rows]);
}

export function useOpsWatches(): OpsWatch[] {
  const rows = useWorkspaceCollection<OpsWatch>("opsWatches", watchSig);
  return useMemo(() => [...rows].sort((a, b) => a.name.localeCompare(b.name)), [rows]);
}

/** A row named by its short id or its _id, out of an already-read list. */
export function byRef<T extends { _id: string; short_id?: string }>(rows: T[], ref: string | null): T | undefined {
  if (!ref) return undefined;
  return rows.find((r) => r.short_id === ref || r._id === ref);
}

const sampleSig = (s: OpsSample) => `${s.at}`;

/** A group's newest samples, capped where the server caps them. */
export function useOpsSamples(groupId: string | undefined): OpsSample[] {
  const where = useMemo(() => (s: OpsSample) => !!groupId && s.group_id === groupId, [groupId]);
  const rows = useCollectionRows<OpsSample>("opsSamples", { where, sig: sampleSig, sort: byNewest((s) => s.at) });
  return useMemo(() => rows.slice(0, GROUP_RULES.samples_per_group), [rows]);
}

const timelineSig = (t: OpsReplayTimeline) => `${t.timeline_at ?? 0}|${t.groups.length}`;

export function useOpsReplayTimeline(replayId: string | undefined): OpsReplayTimeline | undefined {
  const where = useMemo(() => (t: OpsReplayTimeline) => !!replayId && t._id === replayId, [replayId]);
  return useCollectionRows<OpsReplayTimeline>("opsReplayTimelines", { where, sig: timelineSig })[0];
}

const appSig = (a: OpsApp) => `${a.manifest_fetched_at ?? 0}|${(a.grants ?? []).map((g) => `${g.action}:${g.until ?? ""}`).join(",")}|${a.watch_state?.length ?? 0}|${a.source.status}`;

export function useOpsApp(sourceId: string | undefined): OpsApp | undefined {
  const where = useMemo(() => (a: OpsApp) => !!sourceId && a._id === sourceId, [sourceId]);
  return useCollectionRows<OpsApp>("opsApps", { where, sig: appSig })[0];
}

const callSig = (c: OpsAppCall) => `${c.created_at}|${c.status}`;

export function useOpsAppCalls(sourceId: string | undefined): OpsAppCall[] {
  const where = useMemo(() => (c: OpsAppCall) => !!sourceId && c.source_id === sourceId, [sourceId]);
  const rows = useCollectionRows<OpsAppCall>("opsAppCalls", { where, sig: callSig, sort: byNewest((c) => c.created_at) });
  return useMemo(() => rows.slice(0, OPS_LIST_LIMIT.calls), [rows]);
}

// ── The release's commit (issue page: release, commit, the session that wrote it) ──

/** The sha a group names: its own, else a release that is itself a sha. */
export function groupSha(g: { last_sha?: string; last_release?: string } | undefined): string | null {
  if (g?.last_sha) return g.last_sha.toLowerCase();
  const r = g?.last_release?.trim().toLowerCase();
  return r && /^[0-9a-f]{7,40}$/.test(r) ? r : null;
}

const oneRow = (row: unknown) => (row ? [row] : []);

/** Feeds the commit a sha names (full or abbreviated) into the shared commits collection. */
export function useSyncShaCommit(sha: string | null) {
  return useSyncCollection("commits", api.commits.webGet, sha ? { sha } : "skip", { select: oneRow });
}

const commitSig = (c: any) => `${c.sha}|${c.conversation_id ?? ""}|${c.message ?? ""}`;

export function useShaCommit(sha: string | null): any | undefined {
  const where = useMemo(() => (c: any) => !!sha && typeof c.sha === "string" && c.sha.startsWith(sha), [sha]);
  return useCollectionRows<any>("commits", { where, sig: commitSig })[0];
}
