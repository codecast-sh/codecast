// External data on the Ops page (docs/architecture/external-data.md X10): the
// feeders that hand each live query to its store collection, and the readers
// the page paints from. Every collection is registered in
// store/clientSyncRegistry.ts; nothing under app/ or components/ subscribes to
// these queries directly.
import { useMemo, useState } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { GROUP_RULES } from "@codecast/shared/contracts/ingest";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import type { SyncOpts } from "../store/inboxStore";
import { useSyncCollection, type SyncCollectionResult } from "./useSyncCollection";
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { useCollectionRows } from "./useCollectionRows";
import type { OpsApp, OpsAppCall, OpsCiRun, OpsEvent, OpsGroup, OpsReplay, OpsReplayTally, OpsReplayTimeline, OpsSample, OpsSource, OpsWatch } from "../components/ops/opsTypes";
import { type ReplayMatch, type ReplaySort } from "@codecast/shared/replay";
import { useWatchEffect } from "./useWatchEffect";

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

/** How many open groups the open feeder asks for: the server's list cap. */
export const OPS_OPEN_GROUPS_LIMIT = 500;

/**
 * Every open group of the workspace, beside the newest window: the Issues
 * badge and the list's Open count are taken over these rows, so both read one
 * home and agree. Its answer vouches for the workspace's open rows newer than
 * its oldest (all of them when short); a cached row it no longer carries has
 * been resolved or ignored, and the newest window brings it back as such.
 */
export function useSyncOpsOpenGroups() {
  const scope = useOpsScope();
  const scopeKey = scope === "skip" ? "" : JSON.stringify(scope);
  // Past a full first page the feeder walks older pages on its own, each from
  // the oldest row of the page before. A row the store holds as open that no
  // page carries any more was resolved or ignored, and each page's answer
  // drops it; without the walk, an open row older than the first page was
  // never vouched for and stayed open in the store after the server settled it.
  const [walk, setWalk] = useState<{ key: string; workspace: string | null; cursors: (number | null)[] }>({ key: scopeKey, workspace: null, cursors: [] });
  const cur = walk.key === scopeKey ? walk : { key: scopeKey, workspace: null, cursors: [] };
  const onPage = (i: number) => (rows: OpsGroup[] | null | undefined, before: number | null): SyncOpts | undefined => {
    if (!Array.isArray(rows)) return undefined;
    const full = rows.length >= OPS_OPEN_GROUPS_LIMIT;
    const floor = full ? Math.min(...rows.map((g) => g.last_seen)) : null;
    const seen = rows[0]?.workspace ?? null;
    queueMicrotask(() =>
      setWalk((w) => {
        const base = w.key === scopeKey ? w : { key: scopeKey, workspace: null, cursors: [] };
        const cursors = base.cursors.slice(0, i + 1);
        // A cursor follows its page's oldest row up at once (a cursor below it
        // would leave a gap no page vouches for), and down only past a day: a
        // page that overlaps the one before costs nothing, and a cursor that
        // moved with every bump at the page's edge would re-subscribe the walk.
        const prev = base.cursors[i] ?? null;
        cursors[i] = floor === null ? null : prev !== null && floor <= prev && prev - floor < OPEN_WALK_SLACK_MS ? prev : floor;
        const workspace = base.workspace ?? seen;
        const same = workspace === base.workspace && cursors.length === base.cursors.length && cursors.every((c, k) => c === base.cursors[k]);
        return same ? base : { key: scopeKey, workspace, cursors };
      }),
    );
    // A page's scope is its workspace's open rows newer than its oldest (all of them when short), under its cursor.
    const workspace = seen ?? cur.workspace;
    // The first page's empty answer vouches for nothing: it is also what a reader sees for a beat before its identity settles.
    if (!workspace || (i === 0 && !rows.length)) return undefined;
    const pageFloor = floor ?? -Infinity;
    return { pruneAbsentScope: (g: any) => isConvexId(String(g?._id ?? "")) && g.workspace === workspace && g.status === "open" && g.last_seen > pageFloor && (before === null || g.last_seen < before) };
  };
  const first = useSyncCollection("opsGroups", api.ingest.listGroups, useMemo(() => withScope(scope, { status: "open", limit: OPS_OPEN_GROUPS_LIMIT }), [scope]), useMemo(() => ({ syncOpts: (rows: any) => onPage(0)(rows, null) }), [scopeKey, cur.workspace])); // eslint-disable-line react-hooks/exhaustive-deps
  useOpenPage(scope, cur.cursors[0] ?? null, onPage(1), scopeKey, cur.workspace);
  useOpenPage(scope, cur.cursors[1] ?? null, onPage(2), scopeKey, cur.workspace);
  useOpenPage(scope, cur.cursors[2] ?? null, onPage(3), scopeKey, cur.workspace);
  return first;
}

/** How far a walk's cursor may sit above its page's oldest row before it follows it down. */
const OPEN_WALK_SLACK_MS = 24 * 60 * 60 * 1000;

/** One older page of the open walk: the open groups last seen before `before`. */
function useOpenPage(scope: ReturnType<typeof useOpsScope>, before: number | null, onPage: (rows: OpsGroup[] | null | undefined, before: number | null) => SyncOpts | undefined, scopeKey: string, workspace: string | null) {
  const args = useMemo(() => (before !== null ? withScope(scope, { status: "open", before, limit: OPS_OPEN_GROUPS_LIMIT }) : "skip"), [scope, before]);
  const opts = useMemo(() => ({ syncOpts: (rows: any) => onPage(rows, before) }), [before, scopeKey, workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  useSyncCollection("opsGroups", api.ingest.listGroups, args, opts);
}

/**
 * One source's open groups, while a view is scoped to it (its overview, its
 * stream). The workspace's open feeder stops at its cap, so an open row older
 * than that page's oldest is never vouched for and stays cached as open after
 * the server resolved it; a source's own answer is usually short, so it
 * vouches for every open row of that source and drops the stale ones.
 */
export function useSyncOpsSourceOpenGroups(sourceId: string | null) {
  const scope = useOpsScope();
  const ok = !!sourceId && isConvexId(sourceId);
  const args = useMemo(() => (ok ? withScope(scope, { source: sourceId!, status: "open", limit: OPS_OPEN_GROUPS_LIMIT }) : "skip"), [scope, ok, sourceId]);
  const opts = useMemo(() => ({ syncOpts: sourceOpenPrune(sourceId ?? "") }), [sourceId]);
  return useSyncCollection("opsGroups", api.ingest.listGroups, args, opts);
}

/** What one source's open answer vouches for: that source's open rows in the answer's workspace, newer than its oldest (all of them when short). */
export function sourceOpenPrune(sourceId: string) {
  return (rows: OpsGroup[] | null | undefined): SyncOpts | undefined => {
    const workspace = Array.isArray(rows) ? rows[0]?.workspace : undefined;
    return workspace && sourceId ? windowPrune(rows!, OPS_OPEN_GROUPS_LIMIT, (g) => g.last_seen, (g) => g.workspace === workspace && g.source_id === sourceId && g.status === "open") : undefined;
  };
}

/**
 * The groups of one settled status (resolved, ignored, muted), beside the
 * open feeder, for the Issues list while it shows that status: without it the
 * list holds only the settled groups that happen to sit in the newest window.
 * Its answer vouches for that status's rows newer than its oldest.
 */
export function useSyncOpsStatusGroups(status: "resolved" | "ignored" | "muted" | null) {
  const scope = useOpsScope();
  const args = useMemo(() => (status ? withScope(scope, { status, limit: OPS_OPEN_GROUPS_LIMIT }) : "skip"), [scope, status]);
  const opts = useMemo(
    () => ({
      syncOpts: (rows: OpsGroup[] | null | undefined): SyncOpts | undefined => {
        const workspace = Array.isArray(rows) ? rows[0]?.workspace : undefined;
        return workspace && status ? windowPrune(rows!, OPS_OPEN_GROUPS_LIMIT, (g) => g.last_seen, (g) => g.workspace === workspace && g.status === status) : undefined;
      },
    }),
    [status],
  );
  return useSyncCollection("opsGroups", api.ingest.listGroups, args, opts);
}

/**
 * The next page of one status's groups, older than `before` (the oldest the
 * list holds), for an Issues list a reader walked to the end of. Its answer
 * vouches for that status's rows between its oldest and `before`.
 */
export function useSyncOpsOlderGroups(status: "open" | "resolved" | "ignored" | "muted", before: number | null) {
  const scope = useOpsScope();
  const args = useMemo(() => (before !== null ? withScope(scope, { status, before, limit: OPS_OPEN_GROUPS_LIMIT }) : "skip"), [scope, status, before]);
  const opts = useMemo(
    () => ({
      syncOpts: (rows: OpsGroup[] | null | undefined): SyncOpts | undefined => {
        const workspace = Array.isArray(rows) ? rows[0]?.workspace : undefined;
        return workspace && before !== null ? windowPrune(rows!, OPS_OPEN_GROUPS_LIMIT, (g) => g.last_seen, (g) => g.workspace === workspace && g.status === status && g.last_seen < before) : undefined;
      },
    }),
    [status, before],
  );
  return useSyncCollection("opsGroups", api.ingest.listGroups, args, opts);
}

/**
 * The groups whose title matches the Issues list's search, from the server
 * (ingest.searchGroups), into opsGroups: the list then filters what it holds,
 * which now includes matches past the windows. Upserts only; a debounced
 * query, skipped under two characters.
 */
export function useSyncOpsGroupSearch(q: string) {
  const scope = useOpsScope();
  const [term, setTerm] = useState(q.trim());
  useWatchEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const args = useMemo(() => (term.length >= 2 ? withScope(scope, { q: term, limit: 100 }) : "skip"), [scope, term]);
  return useSyncCollection("opsGroups", api.ingest.searchGroups, args);
}

/** One group's transitions over `days`, and its source's deploys, into opsEvents (ingest.groupTransitions). Upserts only. */
const groupTransitionRows = { select: (d: any) => (d && Array.isArray(d.events) ? d.events : undefined) };
export function useSyncOpsGroupTransitions(ref: string | null, days: number) {
  const args = ref ? { group: ref, days } : "skip";
  return useSyncCollection("opsEvents", api.ingest.groupTransitions, args, groupTransitionRows);
}

export function useSyncOpsEvents() {
  const scope = useOpsScope();
  const args = useMemo(() => withScope(scope, { limit: OPS_LIST_LIMIT.events }), [scope]);
  return useSyncCollection("opsEvents", api.ingest.listEvents, args, eventsWindow(null, null));
}

/**
 * The prune one page of the event stream may make: the rows of its workspace
 * (and source, when it names one) between its oldest row and `before`. Pages
 * are newest first, so a full page vouches from its oldest row up, and a short
 * one for everything older than `before` too.
 */
function eventsWindow(sourceId: string | null, before: number | null) {
  return {
    syncOpts: (rows: OpsEvent[] | null | undefined): SyncOpts | undefined => {
      const workspace = Array.isArray(rows) ? rows[0]?.workspace : undefined;
      if (!workspace) return undefined;
      const ceiling = before ?? Infinity;
      return windowPrune(rows!, OPS_LIST_LIMIT.events, (e) => e.created_at, (e) => e.workspace === workspace && (!sourceId || e.source_id === sourceId) && e.created_at < ceiling);
    },
  };
}

/**
 * More of the stream than the newest page: one source's newest page (a quiet
 * source's last events sit far past the workspace's newest), and the pages
 * older than each cursor a reader has scrolled to. Every page lands in
 * opsEvents beside the newest one.
 */
export function useSyncOpsEventPages(sourceId: string | null, befores: readonly number[]) {
  const scope = useOpsScope();
  const sourceArgs = useMemo(() => (sourceId && isConvexId(sourceId) ? withScope(scope, { source: sourceId, limit: OPS_LIST_LIMIT.events }) : "skip"), [scope, sourceId]);
  const sourceOpts = useMemo(() => eventsWindow(sourceId, null), [sourceId]);
  const sourceFeed = useSyncCollection("opsEvents", api.ingest.listEvents, sourceArgs, sourceOpts);
  // At most a few older pages are open at once; each is its own subscription, in order.
  const pages = [befores[0] ?? null, befores[1] ?? null, befores[2] ?? null, befores[3] ?? null, befores[4] ?? null];
  const feeds = pages.map((before) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a fixed five, so the hook order never changes
    const args = useMemo(() => (before == null ? "skip" : withScope(scope, { ...(sourceId && isConvexId(sourceId) ? { source: sourceId } : {}), before, limit: OPS_LIST_LIMIT.events })), [scope, before, sourceId]);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const opts = useMemo(() => eventsWindow(sourceId, before), [before, sourceId]);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useSyncCollection("opsEvents", api.ingest.listEvents, args, opts);
  });
  return { source: sourceFeed, pages: feeds };
}

/** A page of the Timeline's occurrences (ingest.listSamples SAMPLE_PAGE). */
export const OPS_SAMPLE_PAGE = 50;

/**
 * The Timeline's occurrence rows: the samples groups keep, the workspace's (or
 * one source's) newest page and the pages before each cursor a reader asked
 * for, into opsSamples beside the ones an opened issue fed. Each page vouches
 * for its own span, as the event pages do. Off: nothing is subscribed.
 */
export function useSyncOpsStreamSamples(on: boolean, sourceId: string | null, befores: readonly number[]) {
  const scope = useOpsScope();
  const src = sourceId && isConvexId(sourceId) ? sourceId : null;
  const pages = [null, befores[0] ?? null, befores[1] ?? null, befores[2] ?? null, befores[3] ?? null];
  return pages.map((before, i) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a fixed five, so the hook order never changes
    const args = useMemo(() => (!on || (i > 0 && before == null) ? "skip" : withScope(scope, { ...(src ? { source: src } : {}), ...(before != null ? { before } : {}), limit: OPS_SAMPLE_PAGE })), [on, scope, before, src, i]);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const opts = useMemo(() => ({
      syncOpts: (rows: OpsSample[] | null | undefined): SyncOpts | undefined => {
        const workspace = Array.isArray(rows) ? (rows[0] as { workspace?: string } | undefined)?.workspace : undefined;
        if (!workspace) return undefined;
        const ceiling = before ?? Infinity;
        return windowPrune(rows!, OPS_SAMPLE_PAGE, (s) => s.at, (s) => (s as { workspace?: string }).workspace === workspace && (!src || s.source_id === src) && s.at < ceiling);
      },
    }), [before, src]);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useSyncCollection("opsSamples", api.ingest.listSamples, args, opts);
  });
}

const streamSampleSig = (s: OpsSample) => `${s.group_id}|${s.at}`;

/** The occurrences the store holds, newest first (one source's, when named). */
export function useOpsStreamSamples(sourceId: string | null): OpsSample[] {
  const where = useMemo(() => (s: OpsSample) => !sourceId || s.source_id === sourceId, [sourceId]);
  return useCollectionRows<OpsSample>("opsSamples", { where, sig: streamSampleSig, sort: byNewest((s) => s.at) });
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
/**
 * An answer holds every sample its group keeps: the server holds at most
 * samples_per_group and trims the oldest as new ones land, so a cached sample
 * of that group the answer lacks was trimmed and leaves (else the page counts
 * and tags samples the server dropped, and its newest drifts from the group's).
 */
export const groupSamplesPrune = (d: any): SyncOpts | undefined =>
  d?.group?._id ? windowPrune<OpsSample>(d.samples ?? [], Infinity, (s) => s.at, (s) => s.group_id === d.group._id) : undefined;
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
  useWatchEffect(() => {
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
  useWatchEffect(() => {
    if (gone && ref) dropGoneRow("opsReplays", ref);
  }, [gone, ref]);
  return replay;
}

/** A replay browse as the list asks it (replays.browse): a source, a resolved filter, a sort and how many rows. */
export type ReplayBrowse = { source?: string | null; match: ReplayMatch; sort: ReplaySort; limit: number; people?: ReplayPeopleAsk };
/** How the grouped list asks for people: an order, how many, and whether to leave out the ones known only by an id. */
export type ReplayPeopleAsk = { sort: string; limit: number; identified: boolean };

/**
 * The key a browse's tally lives under in opsReplayTallies: the workspace,
 * the source and the filter. Not the sort or the page size, which change the
 * rows sent but not what matches, so "Show more" keeps its total.
 */
export function replayBrowseKey(scope: Exclude<ReturnType<typeof useOpsScope>, "skip">, b: Pick<ReplayBrowse, "source" | "match" | "people">): string {
  const m = b.match;
  const key: unknown[] = ["team_id" in scope ? scope.team_id : "personal", b.source ?? null, m.q ?? "", m.person ?? "", [...(m.has ?? [])].sort().join(","), m.min_ms ?? null, m.max_ms ?? null, m.since ?? null];
  // The environment filters join the key only when set, so the keys of browses without them stay as they were.
  if (m.browser || m.os || m.device || m.country) key.push(m.browser ?? "", m.os ?? "", m.device ?? "", m.country ?? "");
  if (m.active_min_ms || m.group) key.push(m.active_min_ms ?? 0, m.group ?? "");
  // The people asked for change the people answered, so a grouped browse keeps its own tally.
  if (b.people) key.push(b.people.sort, b.people.limit, b.people.identified ? 1 : 0);
  return JSON.stringify(key);
}

const browseRows = { select: (d: any) => d?.rows ?? null };

/**
 * One page of the replay list (replays.browse): its rows into opsReplays, and
 * what it counted (the total, the people) into opsReplayTallies under
 * replayBrowseKey. The page paints from the store with the same filter
 * (shared/replay/list.ts), so a cached page shows at once.
 */
export function useSyncOpsReplayBrowse(b: ReplayBrowse | null): { key: string | null; feed: SyncCollectionResult } {
  const scope = useOpsScope();
  const key = scope === "skip" || !b ? null : replayBrowseKey(scope, b);
  const args = useMemo(
    () => (key && b ? withScope(scope, { ...(b.source ? { source: b.source } : {}), ...b.match, sort: b.sort, limit: b.limit, people: true, ...(b.people ? { people_sort: b.people.sort, people_limit: b.people.limit, identified: b.people.identified } : {}) }) : "skip"),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key spells the scope, source and filter
    [key, b?.sort, b?.limit],
  );
  const tally = useMemo(
    () => ({ select: (d: any) => (d && key ? [{ _id: key, workspace: d.workspace, total: d.total, capped: !!d.capped, people_total: d.people_total ?? 0, people: d.people ?? null, ...(typeof d.people_anonymous === "number" ? { people_anonymous: d.people_anonymous } : {}), ...(typeof d.rage_unchecked === "number" ? { rage_unchecked: d.rage_unchecked } : {}), ...(typeof d.below_active === "number" ? { below_active: d.below_active } : {}), ...(typeof d.oldest_at === "number" ? { oldest_at: d.oldest_at } : {}), ...(d.facets ? { facets: d.facets } : {}) }] : null) }),
    [key],
  );
  const feed = useSyncCollection("opsReplays", api.replays.browse, args, browseRows);
  useSyncCollection("opsReplayTallies", api.replays.browse, args, tally);
  return { key, feed };
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

const sourceSig = (s: OpsSource) => `${s.updated_at}|${s.status}|${s.short_id}|${s.last_event_at ?? 0}|${s.last_poll_at ?? 0}|${s.groups_open ?? 0}|${s.replay_backfill?.status ?? ""}:${s.replay_backfill?.updated_at ?? 0}|${s.replay_rest?.at ?? 0}:${s.replay_rest?.cut ?? 0}:${s.replay_rest?.reading ?? ""}:${s.replay_rest?.waiting_until ?? 0}|${(s.grants ?? []).map((g) => `${g.action}:${g.until ?? ""}`).join(",")}`;
const groupSig = (g: OpsGroup) => `${g.updated_at}|${g.status}|${g.count}|${g.last_seen}|${g.signal_task_id ?? ""}|${g.fix_conversation_id ?? ""}|${g.users ?? 0}`;
const eventSig = (e: OpsEvent) => `${e.created_at}`;
const replaySig = (r: OpsReplay) => `${r.updated_at}|${r.chunks}|${r.has_timeline ? 1 : 0}|${r.import_rest?.updated_at ?? 0}|${r.vendor_refresh_after ?? 0}`;
// The edited fields are in the signature too: an edit paints before the server stamps updated_at.
const watchSig = (w: OpsWatch) => `${w.updated_at}|${w.state}|${w.last_at ?? 0}|${w.status}|${w.history?.at ?? 0}:${w.history?.reading ? 1 : 0}|${w.name}|${w.threshold ?? ""}|${w.direction}|${w.unit ?? ""}|${w.interval_ms}|${w.query.length}`;

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

/**
 * One row a detail page names (short id or _id), from the whole collection.
 * The lists above show the active workspace; a page opened by a link or a
 * reference shows the row its detail feeder synced, whichever workspace it
 * is in, the way a task page does: the feeder's read is the access check,
 * and a refusal drops the row (dropGoneRow).
 */
function useOpsRow<T extends { _id: string; short_id?: string }>(key: "opsGroups" | "opsReplays", ref: string | null, sig: (row: T) => string): T | undefined {
  const where = useMemo(() => (r: T) => !!ref && (r.short_id === ref || r._id === ref), [ref]);
  return useCollectionRows<T>(key, { where, sig })[0];
}

export function useOpsGroup(ref: string | null): OpsGroup | undefined {
  return useOpsRow<OpsGroup>("opsGroups", ref, groupSig);
}

export function useOpsReplay(ref: string | null): OpsReplay | undefined {
  return useOpsRow<OpsReplay>("opsReplays", ref, replaySig);
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

const tallySig = (t: OpsReplayTally) => `${t.total}|${t.capped ? 1 : 0}|${t.people_total}|${t.people_anonymous ?? -1}|${t.rage_unchecked ?? -1}|${t.below_active ?? -1}|${(t.people ?? []).reduce((h, p) => (Math.imul(h, 31) + p.key.length * 131 + p.key.charCodeAt(0) + p.sessions) | 0, 7)}|${(t.people ?? []).reduce((n, p) => n + p.sessions * 31 + p.errors + p.failed + p.last_at, 0)}|${t.facets ? Object.values(t.facets).reduce((n, f) => n + f.length * 7 + f.reduce((m, [v, c]) => m + v.length * 13 + c, 0), 0) : -1}`;

/** What one replay browse counted (useSyncOpsReplayBrowse), by its key. */
export function useOpsReplayTally(key: string | null): OpsReplayTally | undefined {
  const where = useMemo(() => (t: OpsReplayTally) => !!key && t._id === key, [key]);
  return useCollectionRows<OpsReplayTally>("opsReplayTallies", { where, sig: tallySig })[0];
}

const appSig = (a: OpsApp) => `${a.manifest_fetched_at ?? 0}|${a.manifest_json?.length ?? 0}`;

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

/** Feeds one CI run's detail (jobs, steps, annotations, log tail) of a check issue into opsCiRuns (ciRuns.get). */
export function useSyncOpsCiRun(group: string | null, runId: string | null) {
  return useSyncCollection("opsCiRuns", api.ciRuns.get, group && runId ? { group, run_id: runId } : "skip", { select: oneRow });
}

const ciRunSig = (r: OpsCiRun) => `${r.fetched_at}|${r.error ?? ""}`;

/** One CI run's detail as the store holds it. */
export function useOpsCiRun(runId: string | null): OpsCiRun | undefined {
  const where = useMemo(() => (r: OpsCiRun) => !!runId && r.run_id === runId, [runId]);
  return useCollectionRows<OpsCiRun>("opsCiRuns", { where, sig: ciRunSig })[0];
}

const commitSig = (c: any) => `${c.sha}|${c.conversation_id ?? ""}|${c.message ?? ""}`;

export function useShaCommit(sha: string | null): any | undefined {
  const where = useMemo(() => (c: any) => !!sha && typeof c.sha === "string" && c.sha.startsWith(sha), [sha]);
  return useCollectionRows<any>("commits", { where, sig: commitSig })[0];
}
