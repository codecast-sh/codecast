// Every source's one health reading (sourceHealth.ts), from the store: the
// sources, their groups, replays and watches, the workspace's connections and
// its flow map. Readers only: the surface that mounts this feeds the lists
// (OpsShell does; Settings mounts the feeders itself).
import { createElement, Fragment, useMemo } from "react";
import type { AppConnectionsResult } from "@codecast/shared/contracts";
import { parseAppManifest, watchKey, type AppManifest, type AppWatch } from "@codecast/shared/contracts/appConnector";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useFlowMapRow } from "../../hooks/useFlowMap";
import { OPS_LIST_LIMIT, useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches, useSyncOpsApp } from "../../hooks/useSyncOps";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { CONNECTION_PROVIDERS, sourceActivity, sourceHealth, type AppFailure, type SourceHealth } from "./sourceHealth";
import { liveFailures } from "./appsModel";
import type { OpsApp, OpsAppCall, OpsSource, OpsWatch } from "./opsTypes";
import "./sourceView.css";

/** Connected providers, or null until the list has answered (nothing reads disconnected before anyone looked). */
export function useConnectedProviders(): Set<string> | null {
  const { data } = useSettingsData("connections");
  const apps = (data as AppConnectionsResult | undefined)?.apps;
  return useMemo(() => (apps ? new Set(apps.filter((a) => a.status === "connected").map((a) => a.id as string)) : null), [apps]);
}

/** The flow map's days and last signal per event source, summed over its rows. */
function useMappedActivity(space: string | null): Map<string, { days: number[]; lastAt: number | null }> {
  const map = useFlowMapRow(space);
  return useMemo(() => {
    const out = new Map<string, { days: number[]; lastAt: number | null }>();
    for (const r of map?.sources ?? []) {
      const id = r.opens.eventSourceId;
      if (!id) continue;
      const prev = out.get(id);
      if (!prev) out.set(id, { days: [...r.days], lastAt: r.lastAt });
      else out.set(id, { days: prev.days.map((d, i) => d + (r.days[i] ?? 0)), lastAt: Math.max(prev.lastAt ?? 0, r.lastAt ?? 0) || null });
    }
    return out;
  }, [map]);
}

const anyRow = () => true;
const callSig = (c: OpsAppCall) => `${c.source_id}|${c.created_at}|${c.status}`;
const appSig = (a: OpsApp) => `${a._id}|${a.manifest_json?.length ?? 0}`;

function appManifest(app: OpsApp | undefined): AppManifest | null {
  if (!app?.manifest_json) return null;
  try {
    const parsed = parseAppManifest(JSON.parse(app.manifest_json));
    return parsed.ok ? parsed.manifest : null;
  } catch {
    return null;
  }
}

const manifestWatches = (app: OpsApp | undefined): AppWatch[] => appManifest(app)?.watches ?? [];

/** Each app source's check titles by watch_state key ("check:invariants" reads "Invariants"), as the Apps board names them. */
function useCheckNames(): Map<string, (key: string) => string | undefined> {
  const apps = useCollectionRows<OpsApp>("opsApps", { where: anyRow, sig: appSig });
  return useMemo(() => {
    const out = new Map<string, (key: string) => string | undefined>();
    for (const a of apps) {
      const m = appManifest(a);
      if (!m) continue;
      const titles = new Map(m.watches.map((w) => [watchKey(w), m.readers.find((r) => r.name === w.reader)?.title ?? w.reader]));
      out.set(a._id, (key) => titles.get(key));
    }
    return out;
  }, [apps]);
}

/**
 * Each app source's readers and actions failing right now, from whatever of
 * its call log the store holds (the Apps board and a source's overview feed
 * it), so a source reads Degraded everywhere the board does.
 */
function useAppFailures(sources: readonly OpsSource[], watches: readonly OpsWatch[], now: number): Map<string, AppFailure[]> {
  const calls = useCollectionRows<OpsAppCall>("opsAppCalls", { where: anyRow, sig: callSig });
  const apps = useCollectionRows<OpsApp>("opsApps", { where: anyRow, sig: appSig });
  return useMemo(() => {
    const out = new Map<string, AppFailure[]>();
    if (!calls.length) return out;
    const bySource = new Map<string, OpsAppCall[]>();
    for (const c of calls) bySource.set(c.source_id, [...(bySource.get(c.source_id) ?? []), c]);
    for (const s of sources) {
      // The newest page only, as the Apps board lists it (useOpsAppCalls), so the health line and the board count the same calls.
      const mine = bySource.get(s._id)?.sort((a, b) => b.created_at - a.created_at).slice(0, OPS_LIST_LIMIT.calls);
      if (!mine?.length) continue;
      const failing = liveFailures(mine, { grants: s.grants ?? [], watchState: s.watch_state ?? [], watches: manifestWatches(apps.find((a) => a._id === s._id)), now, metricWatches: watches.filter((w) => w.source_id === s._id) });
      if (failing.length) out.set(s._id, failing);
    }
    return out;
  }, [calls, apps, sources, watches, now]);
}

export function useSourceHealthMap(): Map<string, SourceHealth> {
  const sources = useOpsSources();
  const groups = useOpsGroups();
  const replays = useOpsReplays();
  const watches = useOpsWatches();
  const connected = useConnectedProviders();
  const mapped = useMappedActivity(sources[0]?.workspace ?? null);
  const now = useCoarseNow(60_000);
  const appFailures = useAppFailures(sources, watches, now);
  const checkNames = useCheckNames();
  return useMemo(() => {
    const trail = { groups, replays, watches };
    const out = new Map<string, SourceHealth>();
    for (const s of sources) {
      const activity = sourceActivity(s, trail, now, mapped.get(s._id));
      out.set(s._id, sourceHealth(s, activity, { now, watches, appFailures: appFailures.get(s._id), checkName: checkNames.get(s._id), connected: connected && CONNECTION_PROVIDERS.has(s.provider) ? connected.has(s.provider) : null }));
    }
    return out;
  }, [sources, groups, replays, watches, connected, mapped, now, appFailures, checkNames]);
}

export function useSourceHealth(source: Pick<OpsSource, "_id"> | null | undefined): SourceHealth | undefined {
  const all = useSourceHealthMap();
  return source ? all.get(source._id) : undefined;
}

function AppFeeder({ id }: { id: string }) {
  useSyncOpsApp(id);
  return null;
}

/**
 * Every app source's manifest and recent calls, so its health names the same
 * failing readers and checks as the Apps board wherever Ops is open, not only
 * after the board was visited.
 */
export function AppHealthFeeders() {
  const sources = useOpsSources();
  return createElement(Fragment, null, ...sources.filter((s) => s.provider === "app").map((s) => createElement(AppFeeder, { key: s._id, id: s._id })));
}
