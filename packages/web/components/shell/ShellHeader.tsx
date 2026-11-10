import { lazy, memo, Suspense, useMemo } from "react";
import { Search } from "lucide-react";
import { ErrorBoundary } from "../ErrorBoundary";
import { UserMenu } from "../UserMenu";
import { GlobalSearch } from "../GlobalSearch";
import { NotificationBell } from "../NotificationBell";
import { ResourcePressureGauge, ResourcePressureFallback } from "../resources/ResourcePressureGauge";
import { DaemonStatusChip } from "../DaemonStatusChip";
import { AccountUsageChip } from "../AccountUsageChip";
import { TopbarButton, TopbarChip, TopbarTray } from "../TopbarButton";
import { NewMenu } from "../NewMenu";
import { HeaderPins } from "../anchor/AnchorPanel";
import { SyncStatusChip } from "../SyncStatusChip";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { FollowPill } from "../presence/FollowPill";
import { useInboxStore, useTrackedStore, sessionsWakeSig, pendingSendWakeSig, resolveShowOld, selectSessionRailOpen, placeInboxRows, filterInboxScope, isSub } from "../../store/inboxStore";
import { agentFleetCounts } from "../../lib/liveness";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpenSession } from "../../hooks/useOpenSession";

const TeamAvatarBar = lazy(() =>
  import("../TeamAvatarBar").then((module) => ({ default: module.TeamAvatarBar })),
);

// The "N agents running" badge is the ONLY thing in the dashboard shell that
// needs the full sessions map. Keeping its subscription here (rather than in
// DashboardLayoutInner) means a streaming session heartbeat re-renders just
// this tiny button instead of the entire shell (Sidebar, CommandPalette,
// keyboard panel, main content) on every tick.
const ActiveAgentsBadge = memo(function ActiveAgentsBadge({ isOnInboxPage }: { isOnInboxPage: boolean }) {
  const openSession = useOpenSession();
  const s = useTrackedStore([
    // Wake on STRUCTURAL change (bucket/order/identity), never on the ~1s
    // liveness heartbeat: the raw s.sessions ref flips on every tick, and this
    // badge was measured re-running the whole classification over the
    // never-prune cache ~3x/sec at ~50ms a pass. The body still reads
    // s.sessions for data; these signatures only gate the re-render. Same for
    // pendingMessages — only the pending-send MEMBERSHIP matters here.
    // See store/wakeSig.ts and the identical gate on SessionListPanel.
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => s.blockedReviveRequestedAt,
    s => pendingSendWakeSig(s.pendingMessages),
    s => s.currentUser?._id,
    s => resolveShowOld(s.clientState.ui),
  ]);
  // The chokepoint's time-driven flips (trust TTL, revive expiry, the epoch)
  // ride its deadline signature — keep them alive with a coarse clock, exactly
  // like SessionListPanel (see useCoarseNow / store/wakeSig.ts).
  const coarseNow = useCoarseNow(15_000);
  // Ambient "active agents" count stays MINE-scoped regardless of inbox scope: a
  // teammate row can linger in the shared cache after a team-board visit, but the
  // dock badge counts YOUR working sessions, not the team's. The placement
  // chokepoint (placeInboxRows, sync-convergence C5) forced to "mine" runs the
  // scope filter and the shared working-set selection internally, so a stale
  // "working" card outside it can never inflate the badge.
  const meId = s.currentUser?._id?.toString?.() ?? null;
  // Deps are the wake signatures (memoized by ref — free to re-call here), not
  // the raw s.sessions/s.pendingMessages refs those flip on every heartbeat.
  const working = useMemo(
    () => placeInboxRows(s, { scope: "mine", now: coarseNow }).working,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsWakeSig(s.sessions), meId, s.sessionsWithQueuedMessages, s.blockedReviveRequestedAt, pendingSendWakeSig(s.pendingMessages), resolveShowOld(s.clientState.ui), coarseNow],
  );
  // The hover breakdown: every agent of mine with a process behind it,
  // subagents included, by the same live rule the dots and buckets read.
  const fleet = useMemo(
    () => agentFleetCounts(Object.values(filterInboxScope(s.sessions, "mine", meId)), isSub, coarseNow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionsWakeSig(s.sessions), meId, coarseNow],
  );
  if (working.length === 0) return null;
  const activeAgentCount = working.length;
  // The placement chokepoint's working set is the badge's number; an agent it
  // counts is awake even if the fleet rule has not caught up to it yet.
  const awakeAgents = Math.max(fleet.sessions.awake, activeAgentCount);
  const n = (count: number, noun: string) => `${count} ${noun}${count !== 1 ? "s" : ""}`;
  return (
    <ShortcutTooltip label={
      <div className="flex flex-col gap-0.5">
        <span>{activeAgentCount + fleet.subagents.working} working: {n(activeAgentCount, "agent")} + {n(fleet.subagents.working, "subagent")}</span>
        <span className="text-sol-text-muted">{awakeAgents + fleet.subagents.awake} awake: {n(awakeAgents, "agent")} + {n(fleet.subagents.awake, "subagent")}</span>
      </div>
    }>
      <TopbarChip
        onClick={() => {
          const store = useInboxStore.getState();
          if (!selectSessionRailOpen(store)) store.toggleSidePanel();
          if (working[0]) openSession(working[0]._id);
        }}
        aria-label={`${activeAgentCount} agent${activeAgentCount !== 1 ? 's' : ''} running`}
      >
        {/* The count alone; the tooltip spells out what it counts. */}
        <span className="text-sol-text">{activeAgentCount}</span>
      </TopbarChip>
    </ShortcutTooltip>
  );
});

// The shell's prop-less chrome, grouped into memo leaves: each part reads the
// store itself, so a shell render (a navigation, a layout change) skips them.

export const HeaderPresence = memo(function HeaderPresence() {
  return <>
    <ErrorBoundary name="TeamAvatarBar" level="inline">
      <Suspense fallback={null}><TeamAvatarBar /></Suspense>
    </ErrorBoundary>
    <ErrorBoundary name="FollowPill" level="inline">
      <FollowPill />
    </ErrorBoundary>
  </>;
});

export const HeaderSearch = memo(function HeaderSearch() {
  return <>
    <ErrorBoundary name="GlobalSearch" level="inline">
      <GlobalSearch />
    </ErrorBoundary>
    {/* Making something pairs with finding it. */}
    <ErrorBoundary name="NewMenu" level="inline">
      <NewMenu />
    </ErrorBoundary>
  </>;
});

export const HeaderStatus = memo(function HeaderStatus({ isOnInboxPage }: { isOnInboxPage: boolean }) {
  return <TopbarTray>
    {/* The sync light leads, the steady facts follow, and an alert
        (the daemon) comes last, where the row's eye lands. */}
    <ErrorBoundary name="SyncStatusChip" level="inline">
      <SyncStatusChip />
    </ErrorBoundary>
    {/* The Claude Code account behind agent sessions. */}
    <ErrorBoundary name="AccountUsageChip" level="inline">
      <AccountUsageChip />
    </ErrorBoundary>
    <ActiveAgentsBadge isOnInboxPage={isOnInboxPage} />
    <ErrorBoundary name="DaemonStatusChip" level="inline">
      <DaemonStatusChip />
    </ErrorBoundary>
  </TopbarTray>;
});

const openPaletteFromHeader = () => useInboxStore.getState().openPalette();

export const HeaderActions = memo(function HeaderActions() {
  return <>
    {/* A phone's bar has no search zone (TopbarRow hides it under sm), so
        search and New come back as two icons: the palette searches
        everything and runs every command. */}
    <TopbarButton onClick={openPaletteFromHeader} className="sm:hidden" aria-label="Search and commands">
      <Search />
    </TopbarButton>
    <div className="flex sm:hidden">
      <ErrorBoundary name="NewMenu" level="inline">
        <NewMenu compact />
      </ErrorBoundary>
    </div>
    <ErrorBoundary name="HeaderPins" level="inline">
      <HeaderPins />
    </ErrorBoundary>
    <ErrorBoundary name="ResourcePressureGauge" level="inline" fallback={<ResourcePressureFallback />}>
      <ResourcePressureGauge />
    </ErrorBoundary>
    <ErrorBoundary name="NotificationBell" level="inline">
      <NotificationBell />
    </ErrorBoundary>
    <ErrorBoundary name="UserMenu" level="inline">
      <UserMenu />
    </ErrorBoundary>
  </>;
});
