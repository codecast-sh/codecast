// The count an Ops page wears in the palette, the same number its tab and the
// sidebar show: the Overview's paging count (opsBadge), Issues' open count
// (issueTotals, summed per source), Replays' browse total (useReplayTotal) and
// Metrics' alerting or blind watches. Red is only for what pages or is broken;
// an open total is a neutral count. Pages with no count (Timeline) render
// nothing; Apps counts the apps connected, as its tab does.
import { useMemo } from "react";
import { OPS_OPEN_GROUPS_LIMIT, useOpsGroups, useOpsSources, useOpsWatches } from "../../hooks/useSyncOps";
import { opsBadge, watchNeedsLook } from "./opsHomeModel";
import { useOpsAttention } from "./useOpsAttention";
import { useSourceHealthMap } from "./useSourceHealth";
import { issueTotals, openFeederFull } from "./issuesModel";
import { useReplayTotal } from "./useReplayTotals";

function Chip({ n, alert, more, title }: { n: number; alert?: boolean; more?: boolean; title?: string }) {
  if (!n) return null;
  return (
    <span className={`flex-shrink-0 rounded-full px-1.5 text-[10.5px] font-semibold tabular-nums leading-[16px] ${alert ? "bg-sol-red text-white" : "bg-sol-bg-alt text-sol-text-muted"}`} title={title} data-ops-page-count={n}>
      {n.toLocaleString()}{more ? "+" : ""}
    </span>
  );
}

function OverviewCount() {
  const health = useSourceHealthMap();
  const items = useOpsAttention(health);
  const { n, words } = useMemo(() => opsBadge(items), [items]);
  return <Chip n={n} alert title={words} />;
}

function IssuesCount() {
  const groups = useOpsGroups();
  const sources = useOpsSources();
  const t = useMemo(() => issueTotals(groups, sources, null, openFeederFull(groups, OPS_OPEN_GROUPS_LIMIT)), [groups, sources]);
  return <Chip n={t.open} more={!t.exact} title="Open issues" />;
}

/** The Replays tab's own badge: the list's default browse, "+" when it is a floor. */
function ReplaysCount() {
  const t = useReplayTotal(null);
  return t ? <Chip n={t.total} more={t.capped} title="Recordings" /> : null;
}

function MetricsCount() {
  const watches = useOpsWatches();
  const n = useMemo(() => watches.filter(watchNeedsLook).length, [watches]);
  return <Chip n={n} alert title="Alerting, blind or erroring" />;
}

/** The Apps tab's count: the apps connected, as the tab reads it. */
function AppsCount() {
  const sources = useOpsSources();
  const n = useMemo(() => sources.filter((s) => s.provider === "app").length, [sources]);
  return <Chip n={n} title={`${n.toLocaleString()} ${n === 1 ? "app" : "apps"} connected`} />;
}

export function OpsPageCount({ path }: { path: string }) {
  if (path === "/ops") return <OverviewCount />;
  if (path === "/ops/issues") return <IssuesCount />;
  if (path === "/ops/replays") return <ReplaysCount />;
  if (path === "/ops/metrics") return <MetricsCount />;
  if (path === "/ops/apps") return <AppsCount />;
  return null;
}
