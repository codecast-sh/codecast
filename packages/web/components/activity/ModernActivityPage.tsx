import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ChartColumn, EyeOff, SearchX } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore, useTrackedStore, sessionsWakeSig, isSessionHidden } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useViewerIdentity } from "../../hooks/useTeamRoster";
import { useTeamFeed, inboxSessionToConv } from "../../hooks/useTeamFeed";
import { settingsDataKey } from "../../lib/settingsData";
import type { Conversation } from "../../lib/conversationRow";
import { ErrorBoundary } from "../ErrorBoundary";
import { MessageFeed } from "../MessageFeed";
import { SegmentedToggle } from "../SegmentedToggle";
import { PageFrame, PageHeader } from "../ui/page-header";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { SkeletonRows } from "../ui/skeleton";
import { ActivityFilterRow, ActivityScopeToggle } from "./ActivityFilters";
import { ActivityDays, ActivityLoadOlder, ActivityNeedsGroup } from "./ActivityList";
import { ActivityNowStrip, ActivitySummaryRow } from "./ActivityNow";
import { useActivityItems } from "./useActivityItems";
import { useActivityView, type ActivityViewState } from "./useActivityView";
import { activityViewHref, type ActivityTab } from "./activityView";
import { filterItems, filterLoose, groupActivity, needsList, nowStrip, peopleFacets, projectFacets, summarize } from "./activityModel";

// The Activity page in the Modern style (Classic and Minimal keep
// components/ActivityFeed). A person comes here to learn four things, and the
// page is laid out in that order:
//   1. who is working on what right now   → the Now strip
//   2. what waits on someone               → Needs someone, each with its action
//   3. what got done                       → days, then people (or projects),
//      each group leading with its PRs, tasks and answers, one line a session
//   4. open the thing                      → every face, title and chip is a link
// The message feed (/feed) is the page's second tab, Messages. The view lives
// in the address (useActivityView), so any view can be sent.

const COLUMN = "mx-auto w-full max-w-4xl px-4 pb-12 pt-4 sm:px-6";
const DAYS_FIRST = 5;
const DAYS_STEP = 5;
const PERSONAL_FIRST = 300;
const PERSONAL_STEP = 200;
const RECONFIRM_MS = 30_000;

export function ModernActivityPage({ tab }: { tab: ActivityTab }) {
  const { user } = useCurrentUser();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as string | undefined;
  const teamId = activeTeamId || (user?.active_team_id as string | undefined) || (user?.team_id as string | undefined) || null;
  const state = useActivityView(tab, !!teamId);
  if (tab === "messages") return <MessagesScreen state={state} hasTeam={!!teamId} />;
  return state.view.scope === "team" && teamId
    ? <TeamActivity state={state} fallbackTeamId={String(teamId)} />
    : <PersonalActivity state={state} hasTeam={!!teamId} />;
}

function ActivityHeader({ tab, state, hasTeam, count, children }: { tab: ActivityTab; state: ActivityViewState; hasTeam: boolean; count?: number | null; children?: ReactNode }) {
  const router = useRouter();
  return (
    <PageHeader
      legacy={null}
      title="Activity"
      icon={Activity}
      count={count}
      tabs={
        <SegmentedToggle
          value={tab}
          onChange={(key) => { if (key !== tab) router.push(state.tabHref(key as ActivityTab)); }}
          items={[{ key: "activity", label: "Activity" }, { key: "messages", label: "Messages" }]}
        />
      }
      actions={hasTeam ? (
        <Button asChild variant="ghost" size="sm">
          <Link href="/team/charts"><ChartColumn aria-hidden />Charts</Link>
        </Button>
      ) : null}
    >
      {children}
    </PageHeader>
  );
}

function MessagesScreen({ state, hasTeam }: { state: ActivityViewState; hasTeam: boolean }) {
  const header = (
    <ActivityHeader tab="messages" state={state} hasTeam={hasTeam}>
      {hasTeam ? <ActivityScopeToggle view={state.view} set={state.set} /> : null}
    </ActivityHeader>
  );
  return (
    <PageFrame header={header} legacyColumn="" column={COLUMN} rootProps={{ "data-activity-page": "messages" }}>
      <ErrorBoundary name="MessageFeed" level="inline">
        <MessageFeed filter={state.view.scope} />
      </ErrorBoundary>
    </PageFrame>
  );
}

// ── sources: the same two the Classic feed reads ───────────────────────────

/** The team's sessions: listConversations(team) cached in the store
 *  (hooks/useTeamFeed), with the viewer's own private rows merged in. */
function TeamActivity({ state, fallbackTeamId }: { state: ActivityViewState; fallbackTeamId: string }) {
  const viewer = useViewerIdentity();
  const activeTeamIdForRoster = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const rosterKey = settingsDataKey("teamMembers", viewer?._id, activeTeamIdForRoster);
  const roster = useInboxStore((s) => (rosterKey ? s.settingsData[rosterKey]?.value : undefined));
  const members = Array.isArray(roster) ? roster : undefined;
  const feed = useTeamFeed({ directoryFilter: state.view.dir, members });
  const teamId = feed.activeTeamId ? String(feed.activeTeamId) : fallbackTeamId;
  const teamName = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === teamId)?.name) as string | undefined;
  // Enrichment only: a failure means no notice, never a broken page.
  const mappings = useQueryNoThrow(api.users.getDirectoryTeamMappings, feed.activeTeamId && !feed.stubTeam ? {} : "skip").data as
    | { team_id?: Id<"teams">; auto_share?: boolean }[]
    | undefined;
  const sharesNone = !!feed.activeTeamId && !feed.stubTeam && Array.isArray(mappings) &&
    !mappings.some((m) => m.team_id?.toString() === teamId && m.auto_share);

  const lastReconfirm = useRef(0);
  const { loadMore, hasMore } = feed;
  const loadOlder = useCallback(() => {
    if (hasMore) { void loadMore(); return; }
    // The believed end of history is re-checked now and then, so a stale
    // persisted "end" can never strand the feed (as the Classic feed does).
    const now = Date.now();
    if (now - lastReconfirm.current < RECONFIRM_MS) return;
    lastReconfirm.current = now;
    void loadMore({ reconfirm: true });
  }, [hasMore, loadMore]);

  return (
    <ActivityScreen
      state={state}
      hasTeam
      rows={feed.rows}
      teamId={teamId}
      teamMode
      hasMore={hasMore}
      loadOlder={loadOlder}
      loadingOlder={feed.loadingMore}
      cold={feed.isLoading && feed.rows.length === 0}
      notice={sharesNone ? <ShareNotice teamId={teamId} teamName={teamName} /> : null}
    />
  );
}

/** The viewer's own sessions: a view over the inbox cache, newest first. */
function PersonalActivity({ state, hasTeam }: { state: ActivityViewState; hasTeam: boolean }) {
  // Woken by structural changes only, never by a heartbeat; the coarse clock
  // refreshes what time moves (the row's time, liveness).
  const st = useTrackedStore([(x) => sessionsWakeSig(x.sessions)]);
  const coarseNow = useCoarseNow(15_000);
  const dir = state.view.dir;
  const [cap, setCap] = useState(PERSONAL_FIRST);
  const all = useMemo(() => {
    const leaf = dir ? dir.split("/").filter(Boolean).pop() : null;
    const out: Conversation[] = [];
    for (const s of Object.values(st.sessions)) {
      if (!s || s.is_subagent || isSessionHidden(s)) continue;
      if (leaf) {
        const path = s.git_root || s.project_path;
        if (!path || !path.split("/").filter(Boolean).includes(leaf)) continue;
      }
      out.push(inboxSessionToConv(s));
    }
    return out.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    // coarseNow: re-read on the coarse clock for the time-driven fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.sessions, dir, coarseNow]);
  const rows = useMemo(() => all.slice(0, cap), [all, cap]);
  const loadOlder = useCallback(() => setCap((c) => c + PERSONAL_STEP), []);
  return (
    <ActivityScreen
      state={state}
      hasTeam={hasTeam}
      rows={rows}
      teamId={null}
      teamMode={false}
      hasMore={all.length > cap}
      loadOlder={loadOlder}
      loadingOlder={false}
      cold={false}
      notice={null}
    />
  );
}

/** One line while the viewer shares no workspace with the team: their work is
 *  invisible to teammates. The press opens the sharing setup, where choosing
 *  what to share is its own deliberate step. */
function ShareNotice({ teamId, teamName }: { teamId: string; teamName?: string }) {
  return (
    <div data-activity-share-notice className="mb-4 flex min-h-10 items-center gap-2 rounded-card border border-sol-border bg-sol-card px-3 py-1.5 text-ui">
      <EyeOff aria-hidden className="size-4 shrink-0 text-sol-text-dim" />
      <span className="min-w-0 flex-1 truncate text-sol-text-muted">Your sessions are hidden from {teamName || "the team"}</span>
      <Button asChild variant="outline" size="sm">
        <Link href={`/settings/team/join?teamId=${teamId}&setup=1`}>Share workspaces</Link>
      </Button>
    </div>
  );
}

// ── the screen ──────────────────────────────────────────────────────────────

function ActivityScreen({ state, hasTeam, rows, teamId, teamMode, hasMore, loadOlder, loadingOlder, cold, notice }: {
  state: ActivityViewState;
  hasTeam: boolean;
  rows: Conversation[];
  teamId: string | null;
  teamMode: boolean;
  hasMore: boolean;
  loadOlder: () => void;
  loadingOlder: boolean;
  cold: boolean;
  notice: ReactNode;
}) {
  const { view, set } = state;
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)), [rows]);
  const { items, loose } = useActivityItems(sorted, { teamId, teamMode });

  const faceFilter = useMemo(() => ({ people: view.people, project: view.project, needs: false }), [view.people, view.project]);
  const scoped = useMemo(() => filterItems(items, faceFilter), [items, faceFilter]);
  const scopedLoose = useMemo(() => filterLoose(loose, faceFilter), [loose, faceFilter]);
  const faces = useMemo(() => peopleFacets(items), [items]);
  const projects = useMemo(() => projectFacets(items), [items]);
  const now = useMemo(() => nowStrip(scoped), [scoped]);
  const needs = useMemo(() => needsList(scoped), [scoped]);
  const summary = useMemo(() => summarize(scoped, scopedLoose), [scoped, scopedLoose]);
  const timeZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const days = useMemo(() => groupActivity(scoped, scopedLoose, view.group, timeZone), [scoped, scopedLoose, view.group, timeZone]);

  const [dayLimit, setDayLimit] = useState(DAYS_FIRST);
  const shownDays = useMemo(() => days.slice(0, dayLimit), [days, dayLimit]);
  const canReveal = dayLimit < days.length;
  const onLoadOlder = useCallback(() => {
    if (canReveal) setDayLimit((n) => n + DAYS_STEP);
    else loadOlder();
  }, [canReveal, loadOlder]);

  const linkTo = useCallback((patch: Partial<typeof view>) => activityViewHref({ ...view, ...patch }, hasTeam), [view, hasTeam]);
  const personHref = useCallback((id: string) => linkTo({ people: [id] }), [linkTo]);
  const projectHref = useCallback((name: string) => linkTo({ project: name }), [linkTo]);
  const filtered = view.people.length > 0 || !!view.project || view.needs;
  const clear = () => set({ people: [], project: null, needs: false });

  const header = (
    <ActivityHeader tab="activity" state={state} hasTeam={hasTeam}>
      <ActivityFilterRow view={view} set={set} hasTeam={hasTeam} faces={faces} projects={projects} needsCount={needs.length} />
    </ActivityHeader>
  );

  let body: ReactNode;
  if (cold) {
    body = <SkeletonRows rows={8} rowClassName="h-7" />;
  } else if (items.length === 0 && loose.length === 0) {
    body = <EmptyState icon={Activity} title={teamMode ? "No team sessions yet" : "No sessions yet"} />;
  } else if (view.needs) {
    body = needs.length > 0
      ? <ActivityNeedsGroup items={needs} all teamId={teamId} />
      : <EmptyState icon={Activity} title="Nothing waits on anyone" secondary={{ label: "Show everything", onClick: clear }} />;
  } else {
    body = (
      <>
        <ActivityNowStrip people={now} personHref={personHref} />
        {scoped.length > 0 && <ActivitySummaryRow summary={summary} />}
        {needs.length > 0 && <ActivityNeedsGroup items={needs} teamId={teamId} />}
        {days.length > 0 ? (
          <ActivityDays days={shownDays} by={view.group} teamId={teamMode ? teamId : null} personHref={personHref} projectHref={projectHref} />
        ) : filtered ? (
          <EmptyState icon={SearchX} title="Nothing matches" secondary={{ label: "Clear filters", onClick: clear }} />
        ) : null}
        <ActivityLoadOlder onLoad={onLoadOlder} busy={loadingOlder} shown={shownDays.length * 1000 + scoped.length} more={canReveal || hasMore} />
      </>
    );
  }

  return (
    <PageFrame header={header} legacyColumn="" column={COLUMN} rootProps={{ "data-activity-page": "activity" }}>
      {notice}
      <ErrorBoundary name="ModernActivity" level="inline">{body}</ErrorBoundary>
    </PageFrame>
  );
}
