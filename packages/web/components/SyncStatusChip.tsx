import { Check, Loader2 } from "lucide-react";
import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

// A healthy cold-open sync settles in a few seconds, and a catch-up after
// hours away replays its backlog in well under twenty. Past this the backend
// is genuinely slow (or stalled) — surface that as a distinct amber state
// rather than an indefinite, identical-looking spin.
const STALL_MS = 20_000;

// Human names for the store scopes the panel lists. liveLoading uses the
// collection scopes; the reconcile crawl also reports the dismiss/stash sweeps.
const SCOPE_LABELS: Record<string, string> = {
  sessions: "Sessions",
  tasks: "Tasks",
  docs: "Docs",
  projects: "Projects",
  plans: "Plans",
  dismissed: "Dismissed sessions",
  stashed: "Stashed sessions",
};
const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? scope;

/**
 * Header status LED. Occupies a fixed slot in every state and never renders
 * text, so the header layout is identical whether it is idle, syncing or
 * stalled. Hovering it expands a panel with the detail: how many scopes are
 * caught up, the per-scope state, and the background backfill's row counts.
 *
 * The LED is always painted — a quiet green when caught up, not a dim gray
 * that reads as "unknown" or "offline". It pulses only for a cold first load
 * (a live subscription still owed its first payload into an empty collection)
 * and for a stall (a sync log catch-up that has dragged past STALL_MS). A warm
 * cache replaying a handful of incoming changes stays green with no pulse:
 * that takes well under a second and happens several times a minute in a busy
 * team. It never keys off `syncProgress` (the background reconcile crawl),
 * which pages every row at a throttled pace for minutes and kept the old pill
 * lit ~forever. The crawl only feeds the hover DETAIL.
 *
 * Color: green when caught up, cyan while a cold load is in flight, amber
 * once a catch-up drags past STALL_MS.
 */
// What the pill waits on, in order of what "not caught up" honestly means now
// that the sync log owns catch-up (docs/architecture/sync-log-migration.md):
//   1. A scope whose log cursor is behind its head (`syncLogLag > 0`) — the
//      store is provably missing changes until the applier replays them.
//   2. A live subscription's first payload, but ONLY while its collection is
//      genuinely cold (no cached rows). On a warm cache the store is already
//      complete once the log is caught up; the live first load then merely
//      refreshes the recent window and must not read as "data missing" — the
//      same rule the store uses for when a skeleton is honest.
// Never `syncProgress` (the background crawl) — that conflation kept the old
// spinner lit ~forever on every cold load.
type SyncSelectorState = {
  liveLoading: Record<string, boolean>;
  syncLogLag?: Record<string, number>;
  sessions?: Record<string, unknown>;
  tasks?: Record<string, unknown>;
  docs?: Record<string, unknown>;
  projects?: Record<string, unknown>;
  plans?: Record<string, unknown>;
};
const LIVE_SCOPE_COLLECTION: Record<string, keyof SyncSelectorState> = {
  sessions: "sessions",
  tasks: "tasks",
  docs: "docs",
  projects: "projects",
  plans: "plans",
};
function collectionIsCold(s: SyncSelectorState, scope: string): boolean {
  const key = LIVE_SCOPE_COLLECTION[scope];
  if (!key) return true; // unknown scope: assume cold (fail toward showing)
  const coll = s[key] as Record<string, unknown> | undefined;
  return !coll || Object.keys(coll).length === 0;
}
// Exported for the regression test: { settled, total } over everything the
// pill watches. total === 0 means idle.
export function selectSyncSummary(s: SyncSelectorState): { settled: number; total: number } {
  let settled = 0;
  let total = 0;
  for (const lag of Object.values(s.syncLogLag ?? {})) {
    total++;
    if (lag <= 0) settled++;
  }
  for (const [scope, loading] of Object.entries(s.liveLoading)) {
    if (!collectionIsCold(s, scope)) continue;
    total++;
    if (!loading) settled++;
  }
  return { settled, total };
}
export function selectSyncing(s: SyncSelectorState): boolean {
  const lagByScope = s.syncLogLag;
  if (lagByScope) {
    for (const scope in lagByScope) {
      if (lagByScope[scope] > 0) return true;
    }
  }
  return selectColdLoad(s);
}
// The first-load case on its own: a live subscription still owed its first
// payload into a collection with no cached rows. This is the only routine
// state the LED pulses for — the screen is genuinely empty until it lands.
export function selectColdLoad(s: SyncSelectorState): boolean {
  for (const scope in s.liveLoading) {
    if (s.liveLoading[scope] && collectionIsCold(s, scope)) return true;
  }
  return false;
}

export function selectSyncFlags(s: SyncSelectorState): number {
  const coldLoad = selectColdLoad(s);
  if (coldLoad) return 3;
  const lagByScope = s.syncLogLag;
  if (lagByScope) {
    for (const scope in lagByScope) {
      if (lagByScope[scope] > 0) return 1;
    }
  }
  return 0;
}

const knownScopeRank = (scope: string) => {
  const keys = Object.keys(SCOPE_LABELS);
  const i = keys.indexOf(scope);
  return i === -1 ? keys.length : i;
};

// Scopes the hover panel lists as a progress roster. Empty when nothing is in
// a cold first-load — a settled leftover (Projects with liveLoading=false,
// treated as cold because the collection was empty or unmapped) must not keep
// a "✓ up to date" row on an otherwise idle panel.
export function selectRosterScopes(s: SyncSelectorState): string[] {
  const coldLabeled = Object.keys(s.liveLoading)
    .filter((scope) => SCOPE_LABELS[scope] && collectionIsCold(s, scope));
  const wave = coldLabeled.some((scope) => s.liveLoading[scope]);
  if (!wave) return [];
  return coldLabeled.sort((a, b) => knownScopeRank(a) - knownScopeRank(b) || a.localeCompare(b));
}

export function SyncStatusChip() {
  // Subscribe to stable primitives only: `liveLoading` / `syncProgress` get a
  // new object identity on every crawl page write (~2/s while a backfill runs),
  // and this chip is always mounted in the header. Deriving booleans in the
  // selector keeps Object.is stable so the chip only re-renders when its state
  // actually changes. The full objects are read inside the hover panel, which
  // mounts only while hovered.
  // `syncing` covers every catch-up, including the sub-second replay of a single
  // incoming change on a warm cache — that happens several times a minute in a
  // busy team and is the sync working, not news. It only arms the stall timer.
  // The dot itself lights for a cold first load, or once a catch-up has dragged
  // past STALL_MS.
  const syncFlags = useInboxStore((s) => selectSyncFlags(s));
  const syncing = (syncFlags & 1) !== 0;
  const coldLoad = (syncFlags & 2) !== 0;
  const [stalled, setStalled] = useState(false);
  // Mirror DaemonStatusChip: paint the store-driven dot only once mounted so
  // SSR markup and the first client render agree (no hydration mismatch). The
  // slot itself always renders, so the header never reflows around it.
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => setMounted(true));

  // Arm a timer when sync starts; trip the slow state if it's still going past
  // the threshold. Reset the moment sync settles (the timer is cleared too).
  useWatchEffect(() => {
    if (!syncing) {
      setStalled(false);
      return;
    }
    const t = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(t);
  }, [syncing]);

  // A fixed 20px slot in every state. The LED never carries text, so nothing
  // next to it shifts when sync starts, ticks through scopes, or settles: the
  // only thing that changes is the color and its pulse ring.
  const active = mounted && (coldLoad || stalled);
  const color = !mounted
    ? "var(--sol-text-dim)"
    : stalled
      ? "var(--sol-yellow)"
      : active
        ? "var(--sol-cyan)"
        : "var(--sol-green)";
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="relative hidden md:flex h-7 w-5 flex-shrink-0 items-center justify-center rounded cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan"
            aria-label={`Sync status: ${!mounted || !syncing ? "Up to date" : stalled ? "Sync is slow" : "Syncing"}`}
          >
            <span aria-hidden="true" className="relative flex h-2 w-2">
              {active && (
                <span
                  className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
                  style={{ background: color }}
                />
              )}
              <span
                className="relative inline-flex h-2 w-2 rounded-full transition-[background-color,opacity] duration-300"
                style={{ background: color, opacity: active ? 1 : 0.85 }}
              />
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" sideOffset={6} collisionPadding={8} className="w-[280px] max-w-[calc(100vw-16px)] overflow-hidden border bg-popover p-0 text-popover-foreground shadow-md">
          {mounted && <SyncDetailPanel syncing={syncing} stalled={stalled} color={color} />}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Hover detail: the only consumer of the churning `liveLoading` / `syncProgress`
// objects. Mounted solely while the pill is hovered, so their per-page identity
// churn costs nothing the rest of the time.
function SyncDetailPanel({ syncing, stalled, color }: { syncing: boolean; stalled: boolean; color: string }) {
  const liveLoading = useInboxStore((s) => s.liveLoading);
  const settled = useInboxStore((s) => selectSyncSummary(s).settled);
  const total = useInboxStore((s) => selectSyncSummary(s).total);
  const syncProgress = useInboxStore((s) => s.syncProgress);
  const syncLogLag = useInboxStore((s) => s.syncLogLag);
  const applyStats = useInboxStore((s) => s.syncLogApplyStats);
  const rosterKey = useInboxStore((s) => selectRosterScopes(s).join(","));
  const scopes = rosterKey ? rosterKey.split(",") : [];
  const behind = Object.entries(syncLogLag).filter(([, lag]) => lag > 0);
  const logScopeLabel = (scope: string) =>
    scope.startsWith("user:") ? "Your workspace" : scope.startsWith("team:") ? "Team workspace" : scope;
  const crawls = Object.entries(syncProgress)
    .filter(([, p]) => p.loading)
    .sort(([a], [b]) => knownScopeRank(a) - knownScopeRank(b) || a.localeCompare(b));
  const headline = !syncing ? "Up to date" : stalled ? "Sync is slow" : "Syncing the latest data";
  const hasBody = !syncing || applyStats.direct > 0 || applyStats.refetch > 0 || behind.length > 0 || scopes.length > 0;
  return (
    <div className="min-w-0">
      <div className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-sol-text-dim">Sync status</div>
      <div className="flex items-center gap-2 border-b border-sol-border/60 px-3 py-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="min-w-0 text-xs font-semibold text-sol-text">{headline}</span>
        {syncing && total > 1 && (
          <span className="ml-auto shrink-0 tabular-nums text-[11px] font-normal text-sol-text-dim">
            {settled}/{total}
          </span>
        )}
      </div>
      {hasBody && (
        <div className="space-y-1.5 px-3 py-2">
          {!syncing && <p className="text-xs leading-snug text-sol-text-dim">New changes arrive automatically.</p>}
          {(applyStats.direct > 0 || applyStats.refetch > 0) && (
            <p className="text-[11px] leading-snug tabular-nums text-sol-text-dim">
              {applyStats.direct.toLocaleString()} applied
              {applyStats.refetch > 0 && <> · {applyStats.refetch.toLocaleString()} refetched</>}
            </p>
          )}
          {behind.map(([scope, lag]) => (
            <div key={scope} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 truncate text-sol-text">{logScopeLabel(scope)}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-sol-text-dim">
                <Loader2 className="h-3 w-3 animate-spin" style={{ color }} />
                {lag.toLocaleString()} behind
              </span>
            </div>
          ))}
          {scopes.map((scope) => (
            <div key={scope} className="flex min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 truncate text-sol-text">{scopeLabel(scope)}</span>
              {liveLoading[scope] ? (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-sol-text-dim">
                  <Loader2 className="h-3 w-3 animate-spin" style={{ color }} />
                  loading
                </span>
              ) : (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-sol-text-dim">
                  <Check className="h-3 w-3 text-sol-green" />
                  caught up
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {crawls.length > 0 && (
        <div className="border-t border-sol-border/60 px-3 py-2">
          <div className="pb-1 text-[9px] font-semibold uppercase tracking-wider text-sol-text-dim">
            Background backfill
          </div>
          <div className="space-y-1.5">
            {crawls.map(([scope, p]) => (
              <div key={scope} className="flex min-w-0 items-center gap-2 text-xs">
                <span className="min-w-0 truncate text-sol-text">{scopeLabel(scope)}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-sol-text-dim">
                  <Loader2 className="h-3 w-3 animate-spin opacity-60" />
                  {p.loaded > 0 ? `${p.loaded.toLocaleString()} rows` : "starting"}
                </span>
              </div>
            ))}
          </div>
          <div className="pt-1.5 text-[10px] leading-snug text-sol-text-dim">
            Older items stream in at a throttled pace. The app is usable meanwhile.
          </div>
        </div>
      )}
      {stalled && (
        <div className="border-t border-sol-border/60 px-3 py-2 text-[10px] leading-snug text-sol-yellow">
          Still waiting on the server. Recent data can be incomplete until this settles.
        </div>
      )}
    </div>
  );
}
