// The frame every Ops view renders in: the crumbs (Ops / source / tab / item,
// each a link), the workspace the area is reading, the one source filter, and
// the tab bar with Overview first. The number keys switch tabs, `/` opens the
// source filter, Escape goes up one crumb (item, tab, source, Ops).
import { useMemo, useRef, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Radar, Settings2 } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { TeamIcon } from "../TeamIcon";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { useInboxStore } from "../../store/inboxStore";
import { OPS_LIST_LIMIT, useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches, useSyncOpsGroups, useSyncOpsOpenGroups, useSyncOpsSourceOpenGroups, OPS_OPEN_GROUPS_LIMIT, useSyncOpsReplays, useSyncOpsSources, useSyncOpsWatches } from "../../hooks/useSyncOps";
import { replayCountShown, useReplayTotal } from "./useReplayTotals";
import { OPS_TABS, OPS_TAB_LABEL, opsHref, opsUpHref, opsViewItem, opsViewSource, opsViewTab, type OpsTab, type OpsView } from "./opsPaths";
import { OpsFeedsContext, ProviderIcon, SETUP_HREF, SourceHealthContext, type OpsFeeds } from "./parts";
import { itemsForSource, opsBadge, resolveSource, watchNeedsLook, type AttentionItem } from "./opsHomeModel";
import { useOpsAttention } from "./useOpsAttention";
import { OpsSourceFilter } from "./OpsSourceFilter";
import { issueTotals, openFeederFull } from "./issuesModel";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { AppHealthFeeders, useSourceHealthMap } from "./useSourceHealth";
import type { SourceHealth } from "./sourceHealth";
import { IssueStepper, OpsFreshness, TabMore } from "./OpsShellParts";
import { useForeignItemWorkspace, useTabFit } from "./opsShellHooks";
import { issueOrigin } from "./issueNav";
import { WATCH_KINDS_BY_PROVIDER } from "@codecast/shared/contracts/ingest";
import type { OpsSource } from "./opsTypes";
import "./ops.css";
import "./opsHome.css";

type CountKey = OpsTab | "home";
type TabCount = { n: number; more?: boolean; alert?: boolean; words?: string; /** Not counted by the server yet: a floor, drawn dimmed. */ provisional?: boolean };

/**
 * Each tab's count, narrowed to the source filter. Issues counts the open
 * groups with the list's own totals (issueTotals), so the badge and the
 * list's Open never disagree: exact once the sources' counts arrive, "+"
 * past a full open feeder before then. Replays is the browse's count, "+"
 * when the browse stopped at its scan limit (a floor), else the window the
 * device holds; Metrics counts alerting watches; Apps the app sources under
 * the filter. Overview is exactly what the home lists (the same attention
 * items, useOpsAttention), so it is the sum of the home's tiles.
 */
function useTabCounts(sources: OpsSource[], sourceId: string | null, filtered: boolean, attention: AttentionItem[], /** The source's own open feeder has answered, so its open rows held here are vouched for. */ vouched = true, health?: ReadonlyMap<string, SourceHealth>): Partial<Record<CountKey, TabCount>> {
  const groups = useOpsGroups();
  const replays = useOpsReplays();
  const watches = useOpsWatches();
  // The true count once the Replays tab's browse has counted it (replays.browse), else the window held here.
  // The list's own default browse, fed here too, so the badge reads the same tally on every Ops page (useReplayTotals).
  const replayTotal = useReplayTotal(filtered ? (sources.find((s) => s._id === sourceId)?.name ?? null) : null);
  return useMemo(() => {
    const mine = <T extends { source_id: string }>(rows: T[]) => (filtered ? rows.filter((r) => r.source_id === sourceId) : rows);
    const home = itemsForSource(attention, filtered ? sourceId : null);
    return {
      // What pages a person, the sidebar badge's own count (opsBadge), so the two always read the same number.
      home: { ...opsBadge(home), alert: true },
      // A floor only while the store holds fewer open groups than the sources' own counters say exist.
      // The list's own totals (issueTotals): exact once the sources are counted, a floor past a full open feeder before then.
      issues: (() => {
        // Inside one source, before its own open feeder answers, the rows held may be a stale page: the server's counter speaks, or nothing does.
        if (filtered && !vouched) {
          const src = sources.find((x) => x._id === sourceId);
          return { n: src?.groups_open ?? src?.group_counts?.open ?? 0 };
        }
        // Whether the workspace's open feeder came back full, never one source's share of it: a source's rows past the cap are just as missing.
        const t = issueTotals(groups, sources, filtered ? sourceId : null, openFeederFull(groups, OPS_OPEN_GROUPS_LIMIT));
        // A neutral total: red on a tab is for what pages (Overview) or is broken (Metrics), never every open issue.
        return { n: t.open, more: !t.exact };
      })(),
      // A capped total is a floor that moves by one as recordings land between scans: the badge rounds it down to the hundred, so it reads one number from page to page.
      replays: replayTotal !== null ? { n: replayCountShown(replayTotal), more: replayTotal.capped, provisional: replayTotal.provisional } : { n: mine(replays).length, more: replays.length >= OPS_LIST_LIMIT.replays },
      // The watches the overview sorts to the top: alerting, and erroring (their numbers are stale), the same set as its chips.
      metrics: { n: mine(watches).filter(watchNeedsLook).length, alert: true },
      apps: (() => {
        // Inside one app the count of apps is always 1: the tab counts what fails in it instead (its readers, actions and checks, the
        // Apps head's failing pieces), in alert ink, and nothing when nothing fails.
        if (filtered && sources.find((s) => s._id === sourceId)?.provider === "app") {
          const bad = (sourceId ? health?.get(sourceId)?.problems?.length : 0) ?? 0;
          return bad ? { n: bad, alert: true, words: `${bad.toLocaleString()} failing` } : undefined;
        }
        const n = (filtered ? sources.filter((s) => s._id === sourceId) : sources).filter((s) => s.provider === "app").length;
        return { n, words: `${n.toLocaleString()} ${n === 1 ? "app" : "apps"} connected` };
      })(),
    };
  }, [sources, sourceId, filtered, groups, replays, watches, attention, replayTotal, vouched, health]);
}

/** The order a narrow bar keeps its tabs in: the ones opened most first. */
const TAB_RANK: readonly CountKey[] = ["home", "issues", "replays", "metrics", "timeline", "apps"];

/** The name of the workspace Ops is reading: the active team, else Personal. */
function useWorkspaceFace(): { name: string; icon?: string; color?: string } {
  const team = useInboxStore((s) => {
    const id = s.clientState.ui?.active_team_id;
    return id ? (s.teams as any[] | undefined)?.find((t) => t?._id === id) ?? null : null;
  });
  return team ? { name: team.name ?? "Team", icon: team.icon, color: team.color } : { name: "Personal" };
}

export function OpsShell({ view, children }: { view: OpsView; children: ReactNode }) {
  // The area's base lists: the filter and every tab's count read them, so they
  // are fed wherever in the area a person is. Their readiness goes down to the
  // tabs, which tell "nothing here" from "not answered yet" and "failed".
  const sourcesFeed = useSyncOpsSources();
  const groupsFeed = useSyncOpsGroups();
  useSyncOpsOpenGroups();
  const replaysFeed = useSyncOpsReplays();
  const watchesFeed = useSyncOpsWatches();
  const feeds = useMemo<OpsFeeds>(
    () => ({ sources: sourcesFeed, groups: groupsFeed, replays: replaysFeed, watches: watchesFeed }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the readiness fields stand in for the result objects
    [sourcesFeed.ready, sourcesFeed.error, groupsFeed.ready, groupsFeed.error, replaysFeed.ready, replaysFeed.error, watchesFeed.ready, watchesFeed.error],
  );
  const sources = useOpsSources();
  const router = useRouter();
  const ws = useWorkspaceFace();
  const activeTab = opsViewTab(view);
  const sourceRef = opsViewSource(view);
  const source = resolveSource(sources, sourceRef);
  const sourceFilter = source?.name ?? sourceRef;
  const item = opsViewItem(view);
  // One health reading and one attention list for the whole area: the tab counts here, the filter's dots, every chip and the home read them.
  const health = useSourceHealthMap();
  const attention = useOpsAttention(health);
  // One source's open rows, vouched for by its own answer: the Issues badge waits on it rather than counting a stale page.
  const sourceOpen = useSyncOpsSourceOpenGroups(source?._id ?? null);
  // A name no source here answers to (a typo, another workspace's link) narrows nothing: the tabs keep the workspace's counts, as the page is in no source.
  const counts = useTabCounts(sources, source?._id ?? null, !!source || (!!sourceRef && !sourcesFeed.ready), attention, sourceOpen.ready, health);
  const tabsRef = useRef<HTMLElement>(null);
  const noSources = sourcesFeed.ready && !sources.length;
  // A source that cannot host a metric watch (CI, an ingest key) has no Metrics tab, unless that is where the person already is.
  const noMetrics = !!source && !WATCH_KINDS_BY_PROVIDER[source.provider]?.length && activeTab !== "metrics";
  const tabs: CountKey[] = ["home", ...OPS_TABS.filter((t) => t !== "metrics" || !noMetrics)];
  const hrefOf = (tab: CountKey, src: string | null = sourceFilter) => (tab === "home" ? opsHref.home({ source: src }) : opsHref.tab(tab, { source: src }));
  const up = opsUpHref(view);
  // An item opened from another workspace is a not-found page that says whose it is (OpsArea's ItemGate): the tabs
  // still go to this workspace's lists, so they keep this workspace's counts, as they do under a source link that resolves nowhere.
  const foreign = useForeignItemWorkspace(view);
  // An issue names the list it was opened from (the home's or the Issues tab's), so the crumb goes back there.
  const origin = view.view === "issue" ? issueOrigin(view.id) : null;
  // The tab lit is the list the person is in: an issue opened from the Overview keeps Overview lit, as its crumb says.
  const litTab: CountKey | null = view.view === "home" || origin?.label === "Overview" ? "home" : activeTab;

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      if (e.key === "Escape" && up) {
        if (e.defaultPrevented) return;
        e.preventDefault();
        router.push(up);
        return;
      }
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > tabs.length) return;
      // Before any source the data tabs are inert, from the keyboard too.
      if (noSources && n > 1) return;
      e.preventDefault();
      router.push(hrefOf(tabs[n - 1]));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hrefOf reads sourceFilter
  }, [router, sourceFilter, up, noMetrics, noSources]);

  // The filter keeps the place: a tab stays on its tab, an item goes to its tab.
  const filterHref = (name: string | null) => (activeTab ? opsHref.tab(activeTab, { source: name }) : opsHref.home({ source: name, show: view.view === "home" ? view.show : null }));

  // A narrow bar folds the tabs past its width into a More menu, never cut mid-word.
  // The tabs people open most stay in the bar first (a phone keeps Overview, Issues and Replays); Timeline and Apps fold first.
  const fitted = useTabFit(tabsRef, tabs, litTab, tabs.map((t) => counts[t]?.n ?? 0).join(","), TAB_RANK);

  // A narrow window scrolls the tab bar: keep the active tab in view.
  useWatchEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab, view.view]);

  return (
    <SourceHealthContext.Provider value={health}>
    <AppHealthFeeders />
    <div className="ops-area" data-ops-view={view.view}>
      <header className="ops-head">
        <div className="ops-title-row">
          <nav className="ops-crumbs" aria-label="Breadcrumb">
            <Link href={opsHref.home()} className="ops-crumb ops-crumb-root" data-ops-crumb="home"><Radar className="w-4 h-4" aria-hidden />Ops</Link>
            {source || sourceFilter ? (
              <>
                <span className="ops-crumb-sep" aria-hidden>/</span>
                <Link href={hrefOf(activeTab ?? "home")} className="ops-crumb" data-ops-crumb="source">
                  {source && <ProviderIcon provider={source.provider} className="w-3.5 h-3.5" />}
                  <span className="truncate">{sourceFilter}</span>
                </Link>
              </>
            ) : null}
            {activeTab ? (
              <>
                <span className="ops-crumb-sep" aria-hidden>/</span>
                <Link href={origin?.href ?? hrefOf(activeTab)} className="ops-crumb" data-ops-crumb="tab" aria-current={item ? undefined : "page"}>{origin?.label ?? OPS_TAB_LABEL[activeTab]}</Link>
              </>
            ) : null}
            {item ? (
              <>
                <span className="ops-crumb-sep" aria-hidden>/</span>
                <span className="ops-crumb ops-mono" data-ops-crumb="item" aria-current="page">{item}</span>
                {view.view === "issue" && !foreign ? <IssueStepper id={view.id} /> : null}
              </>
            ) : null}
          </nav>
          <span className="ops-ws" title={`Ops reads the ${ws.name} workspace; the switcher top left changes it`} data-ops-workspace={ws.name} data-foreign={foreign ? "true" : undefined}>
            {ws.icon || ws.color ? <TeamIcon icon={ws.icon} color={ws.color} className="w-3.5 h-3.5" /> : null}
            <span className="truncate">{ws.name}</span>
          </span>
          <div className="ops-head-r">
            <OpsFreshness feeds={feeds} sources={sources} scope={sourceFilter} />
            {!foreign && <OpsSourceFilter sources={sources} value={sourceFilter} hrefFor={filterHref} />}
            <Link href={SETUP_HREF} className="ops-btn shrink-0" title="Connect and set up sources">
              <Settings2 className="w-3.5 h-3.5" />
              <span className="ops-hide-narrow">Sources</span>
            </Link>
          </div>
        </div>
        <nav ref={tabsRef} className="ops-tabs" aria-label="Ops views" data-fit={fitted ? "true" : undefined}>
          {tabs.map((tab) => {
            const c = counts[tab];
            // With nothing connected the data tabs have nothing to show: dimmed and inert until a source exists.
            const empty = tab !== "home" && noSources;
            return (
              <Link key={tab} href={hrefOf(tab)} className="ops-tab" data-active={litTab === tab ? "true" : undefined} data-ops-tab={tab} data-folded={fitted && !fitted.has(tab) ? "true" : undefined} data-empty={empty ? "true" : undefined} aria-disabled={empty || undefined} tabIndex={empty ? -1 : undefined} onClick={empty ? (e) => e.preventDefault() : undefined}>
                {tab === "home" ? "Overview" : OPS_TAB_LABEL[tab]}
                {c && c.n > 0 ? <span className="ops-tab-count" data-alert={c.alert ? "true" : undefined} data-provisional={c.provisional ? "true" : undefined} title={c.words || (c.provisional ? "Counting" : undefined)}>{c.n.toLocaleString()}{c.more ? "+" : ""}</span> : null}
              </Link>
            );
          })}
          {fitted ? (
            <TabMore
              tabs={tabs.filter((t) => !fitted.has(t)).map((t) => {
                const c = counts[t];
                return { key: t, label: t === "home" ? "Overview" : OPS_TAB_LABEL[t], href: hrefOf(t), count: c && c.n > 0 ? `${c.n.toLocaleString()}${c.more ? "+" : ""}` : undefined, alert: c?.alert && c.n > 0, disabled: t !== "home" && noSources };
              })}
            />
          ) : null}
          {/* The number keys switch tabs: one hint at the bar's end, apart from every tab's count. */}
          <span className="ops-tab-keys" aria-hidden title="Switch tabs"><KeyCap size="xs">1</KeyCap>–<KeyCap size="xs">{tabs.length}</KeyCap></span>
        </nav>
      </header>
      <div className="ops-body">
        <OpsFeedsContext.Provider value={feeds}>{children}</OpsFeedsContext.Provider>
      </div>
    </div>
    </SourceHealthContext.Provider>
  );
}
