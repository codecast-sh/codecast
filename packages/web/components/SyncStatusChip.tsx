import { Check, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";

// A healthy cold-open sync settles in a few seconds, and a catch-up after
// hours away replays its backlog in well under twenty. Past this the backend
// is genuinely slow (or stalled) — surface that as a distinct amber state
// rather than an indefinite, identical-looking spin.
const STALL_MS = 20_000;

// Human names for the store scopes the panel lists. liveLoading uses the first
// three; the reconcile crawl also reports the dismiss/stash sweeps.
const SCOPE_LABELS: Record<string, string> = {
  sessions: "Sessions",
  tasks: "Tasks",
  docs: "Docs",
  projects: "Projects",
  dismissed: "Dismissed sessions",
  stashed: "Stashed sessions",
};
const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? scope;

/**
 * Header status dot that lights while the app is pulling fresh data from the
 * server — the cold-open "data syncing in" phase you see right after the desktop
 * app has been closed for a while. It occupies a fixed slot in every state and
 * never renders text, so the header layout is identical whether it is idle,
 * syncing or stalled. Hovering it expands a panel that carries the detail: how
 * many scopes are caught up, the per-scope state, and the background
 * backfill's row counts.
 *
 * Visibility: the dot lights for a cold first load (a live subscription still
 * owed its first payload into an empty collection) and for a stall (a sync log
 * catch-up that has dragged past STALL_MS). It deliberately stays dark for the
 * routine case — a warm cache replaying a handful of incoming changes, which
 * takes well under a second and happens several times a minute in a busy
 * team. It never keys off `syncProgress` (the background reconcile crawl),
 * which pages every row at a throttled pace for minutes and kept the old pill
 * lit ~forever. The crawl only feeds the hover DETAIL.
 *
 * Color carries the health signal: cyan for a normal sync, amber once it drags
 * past STALL_MS so a genuinely slow backend looks different from a quick one.
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
};
const LIVE_SCOPE_COLLECTION: Record<string, keyof SyncSelectorState> = {
  sessions: "sessions",
  tasks: "tasks",
  docs: "docs",
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
// state the dot shows — the screen is genuinely empty until it lands.
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

  // Hover panel with a short close grace timer, same as AccountUsageChip: a
  // diagonal pointer path can briefly exit the dot on its way into the panel,
  // and an instant close makes that read as a dropped hover.
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };
  const closeSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  };

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

  // A fixed 16px slot in every state. The dot never carries text, so nothing
  // next to it shifts when sync starts, ticks through scopes, or settles: the
  // only thing that changes is the dot's color and its pulse ring.
  const active = mounted && (coldLoad || stalled);
  const color = !active ? "var(--sol-text-dim)" : stalled ? "var(--sol-yellow)" : "var(--sol-cyan)";
  return (
    <div
      className="relative hidden md:flex h-7 w-4 flex-shrink-0 items-center justify-center cursor-default"
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
      aria-label={!active ? "Up to date" : stalled ? "Sync is slow" : "Syncing"}
    >
      <span className="relative flex h-2 w-2">
        {active && (
          <span
            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
            style={{ background: color }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full transition-colors duration-300"
          style={{ background: color, opacity: active ? 1 : 0.3 }}
        />
      </span>
      {open && mounted && <SyncDetailPanel syncing={syncing} stalled={stalled} color={color} />}
    </div>
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
  const coldScopes = useInboxStore((s) =>
    Object.keys(s.liveLoading).filter((scope) => collectionIsCold(s, scope)).join(","));
  const known = Object.keys(SCOPE_LABELS);
  const rank = (s: string) => {
    const i = known.indexOf(s);
    return i === -1 ? known.length : i;
  };
  const cold = new Set(coldScopes ? coldScopes.split(",") : []);
  const scopes = Object.keys(liveLoading)
    .filter((scope) => cold.has(scope))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const behind = Object.entries(syncLogLag).filter(([, lag]) => lag > 0);
  const logScopeLabel = (scope: string) =>
    scope.startsWith("user:") ? "Your workspace" : scope.startsWith("team:") ? "Team workspace" : scope;
  const crawls = Object.entries(syncProgress)
    .filter(([, p]) => p.loading)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  return (
    <div className="absolute right-0 top-full z-50 pt-1.5">
      <div className="w-[300px] rounded-md border bg-popover text-popover-foreground shadow-md">
        <div className="flex items-center gap-2 border-b border-sol-border/60 px-3 py-2 text-xs font-semibold text-sol-text">
          <span className="whitespace-nowrap">
            {!syncing ? "Up to date" : stalled ? "Sync is slow" : "Syncing the latest data"}
          </span>
          {syncing && total > 1 && (
            <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums font-normal text-sol-text-dim">
              {settled}/{total} caught up
            </span>
          )}
        </div>
        <div className="px-3 py-2 space-y-1.5">
          {(applyStats.direct > 0 || applyStats.refetch > 0) && (
            <div className="flex items-center gap-2 text-xs">
              <span className="whitespace-nowrap text-sol-text">Log applied</span>
              <span className="ml-auto whitespace-nowrap tabular-nums text-sol-text-dim">
                {applyStats.direct.toLocaleString()} direct · {applyStats.refetch.toLocaleString()} refetched
              </span>
            </div>
          )}
          {behind.map(([scope, lag]) => (
                <div key={scope} className="flex items-center gap-2 text-xs">
                  <span className="whitespace-nowrap text-sol-text">{logScopeLabel(scope)}</span>
                  <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap tabular-nums text-sol-text-dim">
                    <Loader2 className="w-3 h-3 animate-spin" style={{ color }} />
                    {lag.toLocaleString()} change{lag === 1 ? "" : "s"} behind
                  </span>
                </div>
              ))}
          {scopes.map((scope) => (
                <div key={scope} className="flex items-center gap-2 text-xs">
                  <span className="text-sol-text">{scopeLabel(scope)}</span>
                  {liveLoading[scope] ? (
                    <span className="ml-auto flex items-center gap-1.5 text-sol-text-dim">
                      <Loader2 className="w-3 h-3 animate-spin" style={{ color }} />
                      loading…
                    </span>
                  ) : (
                    <span className="ml-auto flex items-center gap-1.5 text-sol-text-dim">
                      <Check className="w-3 h-3 text-sol-green" />
                      up to date
                    </span>
                  )}
                </div>
              ))}
            </div>
            {crawls.length > 0 && (
              <div className="border-t border-sol-border/60 px-3 py-2">
                <div className="pb-1 text-[9px] font-semibold uppercase tracking-wider text-sol-text-dim">
                  Background backfill
                </div>
                <div className="space-y-1.5">
                  {crawls.map(([scope, p]) => (
                    <div key={scope} className="flex items-center gap-2 text-xs">
                      <span className="text-sol-text">{scopeLabel(scope)}</span>
                      <span className="ml-auto flex items-center gap-1.5 tabular-nums text-sol-text-dim">
                        <Loader2 className="w-3 h-3 animate-spin opacity-60" />
                        {p.loaded > 0 ? `${p.loaded.toLocaleString()} rows…` : "starting…"}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="pt-1.5 text-[10px] leading-snug text-sol-text-dim">
                  Streams older items in at a throttled pace — the app is fully usable meanwhile.
                </div>
              </div>
            )}
        {stalled && (
          <div className="border-t border-sol-border/60 px-3 py-2 text-[10px] leading-snug text-sol-yellow">
            Still waiting on the server — it may be under load. Recent data can be incomplete
            until this settles.
          </div>
        )}
      </div>
    </div>
  );
}
