// The frame every Ops view renders in: the title, the workspace's sources as
// chips (a click narrows the tabs to one source), and the tab bar. The number
// keys switch tabs.
import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Radar, Settings2 } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches, useSyncOpsGroups, useSyncOpsReplays, useSyncOpsSources, useSyncOpsWatches } from "../../hooks/useSyncOps";
import { OPS_TABS, OPS_TAB_LABEL, opsHref, type OpsTab, type OpsView } from "./opsPaths";
import { OpsFeedsContext, SETUP_HREF, SourceChip, type OpsFeeds } from "./parts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import "./ops.css";

/** The tabs whose count is work waiting on a person (open issues, alerting watches); the rest are plain totals. */
const ALERT_COUNTS = new Set<OpsTab>(["issues", "metrics"]);

function useTabCounts(): Partial<Record<OpsTab, number>> {
  const groups = useOpsGroups();
  const replays = useOpsReplays();
  const watches = useOpsWatches();
  const sources = useOpsSources();
  return useMemo(
    () => ({
      issues: groups.filter((g) => g.status === "open").length,
      replays: replays.length,
      // Alerting watches only, as Issues counts only open groups (ALERT_COUNTS
      // inks both red). A paused watch alerts nobody.
      metrics: watches.filter((w) => w.state === "alert" && w.status !== "paused").length,
      apps: sources.filter((s) => s.provider === "app").length,
    }),
    [groups, replays, watches, sources],
  );
}

export function OpsShell({ view, children }: { view: OpsView; children: ReactNode }) {
  // The area's base lists: the chips and every tab's count read them, so they
  // are fed wherever in the area a person is. Their readiness goes down to the
  // tabs, which tell "nothing here" from "not answered yet" and "failed".
  const sourcesFeed = useSyncOpsSources();
  const groupsFeed = useSyncOpsGroups();
  const replaysFeed = useSyncOpsReplays();
  const watchesFeed = useSyncOpsWatches();
  const feeds = useMemo<OpsFeeds>(
    () => ({ sources: sourcesFeed, groups: groupsFeed, replays: replaysFeed, watches: watchesFeed }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the readiness fields stand in for the result objects
    [sourcesFeed.ready, sourcesFeed.error, groupsFeed.ready, groupsFeed.error, replaysFeed.ready, replaysFeed.error, watchesFeed.ready, watchesFeed.error],
  );
  const sources = useOpsSources();
  const counts = useTabCounts();
  const router = useRouter();
  const activeTab: OpsTab | null = view.view === "tab" ? view.tab : view.view === "issue" ? "issues" : view.view === "replay" ? "replays" : null;
  const sourceFilter = view.view === "tab" ? view.source : null;

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > OPS_TABS.length) return;
      e.preventDefault();
      router.push(opsHref.tab(OPS_TABS[n - 1], { source: sourceFilter }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, sourceFilter]);

  return (
    <div className="ops-area" data-ops-view={view.view}>
      <header className="ops-head">
        <div className="ops-title-row">
          <span className="ops-title">
            <Radar className="w-4 h-4" strokeWidth={1.75} />
            Ops
          </span>
          <div className="ops-sources">
            {sources.map((s) => (
              <SourceChip
                key={s._id}
                source={s}
                on={sourceFilter === s.name}
                href={activeTab ? opsHref.tab(activeTab, { source: sourceFilter === s.name ? null : s.name }) : undefined}
              >
                {(s.groups_open ?? 0) > 0 && <span className="ops-num" style={{ color: "var(--sol-red)" }}>{s.groups_open}</span>}
              </SourceChip>
            ))}
          </div>
          <Link href={SETUP_HREF} className="ops-btn shrink-0" title="Sources live on Settings, Integrations">
            <Settings2 className="w-3.5 h-3.5" />
            Sources
          </Link>
        </div>
        <nav className="ops-tabs" aria-label="Ops views">
          {OPS_TABS.map((tab, i) => (
            <Link key={tab} href={opsHref.tab(tab, { source: sourceFilter })} className="ops-tab" data-active={activeTab === tab ? "true" : undefined}>
              {OPS_TAB_LABEL[tab]}
              {counts[tab] ? <span className="ops-tab-count" data-alert={ALERT_COUNTS.has(tab) ? "true" : undefined}>{counts[tab]}</span> : null}
              <span className="ops-tab-key"><KeyCap size="xs">{i + 1}</KeyCap></span>
            </Link>
          ))}
        </nav>
      </header>
      <div className="ops-body">
        <OpsFeedsContext.Provider value={feeds}>{children}</OpsFeedsContext.Provider>
      </div>
    </div>
  );
}
