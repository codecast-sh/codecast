// One watched metric (mw-N), at /ops/metrics/mw-N. The chart is the page:
// the watch's whole history read by window from the server (folded to a
// chart's worth), a time range and drag to zoom kept in the address, the line
// and its warning level you can read and drag, the line red only past it,
// the values joined at their own cadence, the previous period dashed, and the
// watch's story as markers (each announced crossing, the problem task, the
// fix session, its commit, the resolve). Until the window's values land the
// plot shows a loading bar and the stats stay blank, so nothing is read off
// the wrong window. The alert is counted one way: episodes the monitor
// announced, and the time they ran (useWatchEpisodes); All reaches back to
// the first announced alert, the stretch with no values held named on the
// chart with the backfill on it. The ships that can move the watch (deploys
// of its source and the sources tied to it, changes landed in its project or
// repository) are ticks on the time axis, hidden by default when there are
// many. The change stat is one rule at every range: the newest span's mean
// against the span before it (All reads the last 7 days). Around it: Mute
// and the one fix action for every fix state (f), the transitions in the
// window (announced, and inferred ones dimmed, each zooms the chart, the rest
// one press away), the issue and its fix as a stepper that shows a
// recurrence, the distribution (and for a plain series the lines its history
// suggests), the query (edit and run onto the chart), the settings (with
// what an alert does) and the source.
import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, BellOff, Check, History, Loader2, Plus, RefreshCw } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOpsGroup, useOpsSources, useOpsWatches, useSyncOpsGroup, useSyncOpsGroupTransitions } from "../../hooks/useSyncOps";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useHeldSeries, useWatchSeries, useWatchSeriesLive } from "../../hooks/useSyncOpsMetrics";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import { relTimeShort } from "../../lib/utils";
import { MONITOR_LIMITS } from "@codecast/shared/contracts/metricMonitor";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { HealthPill, MetricChart } from "./MetricChart";
import { HEALTH_LOOK, KIND_LABEL, METRIC_RANGES, crossings, durationShort, formatMeasure, formatPct, formatValue, inWindow, measuresCount, isMetricRange, isMutedAt, rangeWindow, spanLabel, stampLabel, stats, watchHealth, windowName, type MetricRange, type Pt, type Win } from "./metricModel";
import { CARD_BUCKETS, DETAIL_BUCKETS, changeRange, changeSpan, changeState, changeTone, chartPoints, fullestHeld, periodChange, rangeChange, shiftPoints, stripMean, withAnnouncedReads, type SeriesSpec } from "./metricSeries";
import { currentEpisodeSince, episodeSummary, runningCrossing, relatedShips, shipMarks, SHIPS_SHOWN_MAX, transitionRows, transitionsIn, watchErrorText, watchMarks, windowAround, type ChartMark, type ShipTask, type TransitionRow } from "./metricEvents";
import { allWindow, intervalLabel } from "./metricEditing";
import { opsHref } from "./opsPaths";
import { OpsNotFound } from "./OpsShellParts";
import { OpsFeedEmpty, ProviderIcon, SOURCE_PROVIDER_LABEL, useOpsFeed } from "./parts";
import { QueryEditor, WatchSettings } from "./WatchEditor";
import { removeWatchLedger } from "./watchQuery";
import { fixStage } from "./issuesModel";
import { useWatchEpisodes } from "./useWatchEpisodes";
import { DistributionCard } from "./MetricDistribution";
import { useReadNow } from "./useReadNow";
import { deliveriesByRow, routedSilently, rowKey } from "./alertRouting";
import type { AlertDelivery } from "@codecast/shared/contracts/metricMonitor";
import type { OpsEvent, OpsGroup, OpsSource, OpsWatch } from "./opsTypes";
import "./metrics.css";
import { FixAction, FixPanel } from "./MetricFixPanel";

/** Watch and range pairs whose older values this tab already asked for (WatchView). */
const autoBackfilled = new Set<string>();
/** What a watch from another workspace draws: its last 7 days, and the 7 before for its change. */
const ELSEWHERE_SPEC: SeriesSpec = { kind: "range", range: "7d" };
const ELSEWHERE_PREV_SPEC: SeriesSpec = { kind: "prev", range: "7d" };
/** The labels of the page's stat strip, painted at once while the watch list is on its way. */
const SKELETON_STATS = ["Now", "Last 7d vs prior 7d", "Line", "Range", "Mean", "Episodes"];
/** A read of older values newer than this is the answer: the page does not ask again by itself. */
const BACKFILL_FRESH_MS = 6 * 3_600_000;

export function MetricPage({ id }: { id: string }) {
  const watches = useOpsWatches();
  const feed = useOpsFeed("watches");
  const watch = watches.find((w) => w.short_id === id || w._id === id);
  if (!watch) return <MetricNotFound id={id} feed={feed} />;
  return <WatchView watch={watch} />;
}

/**
 * A watch this workspace's list lacks: the one-watch read (it answers for any
 * workspace the person can read) names where it lives, so a shared alert link
 * offers the switch instead of a dead end, the way issues and replays do.
 */
function MetricNotFound({ id, feed }: { id: string; feed: ReturnType<typeof useOpsFeed> }) {
  const one = useQueryNoThrow(api.metrics.getWatch, { watch: id });
  const active = useActiveWorkspaceKey();
  const elsewhere = one.data?.watch as OpsWatch | undefined;
  const found = elsewhere?.workspace ?? null;
  const workspace = found && found !== active ? found : null;
  if (feed?.error && !feed.ready && !workspace) return <div className="mx-page"><OpsFeedEmpty feeds={[feed]} what={id} title={id} /></div>;
  if (!feed?.ready && !workspace) return <MetricPageSkeleton id={id} />;
  return (
    <>
      {workspace && elsewhere && <ElsewherePreview watch={elsewhere} issue={(one.data?.group as ElsewhereIssue | null | undefined) ?? null} />}
      <OpsNotFound id={id} kind="metric" workspace={workspace} checking={!workspace && !one.data && !one.error} />
    </>
  );
}

/**
 * The page's frame while the watch list is on its way, as Grafana and Datadog
 * paint a panel's frame before its query answers: the id the link named as
 * the title, the stat strip's slots, the range bar and an empty chart under
 * its loading bar. Values fill in where they will stand.
 */
function MetricPageSkeleton({ id }: { id: string }) {
  const now = useCoarseNow(30_000);
  const { range } = useChartWindowParams();
  const win = rangeWindow(range === "all" ? "30d" : range, [], now);
  return (
    <div className="mx-page" data-metric-skeleton={id} aria-busy="true">
      <div className="mx-head">
        <div className="mx-head-main">
          <h1 className="ops-mono ops-dim">{id}</h1>
          <div className="mx-facts"><span className="mx-skel" style={{ width: 64 }} /><span className="mx-skel" style={{ width: 96 }} /><span className="mx-skel" style={{ width: 72 }} /></div>
        </div>
      </div>
      <div className="mx-stats" style={statCols(SKELETON_STATS.length)}>
        {SKELETON_STATS.map((l, i) => <Stat key={l} label={l} value="–" minor={i > 2} />)}
      </div>
      <div className="mx-chart-card">
        <div className="mx-chart-bar">
          <span className="mx-seg" role="group" aria-label="Time range">
            {METRIC_RANGES.map((r) => <button key={r.key} type="button" aria-pressed={range === r.key} disabled>{r.label}</button>)}
          </span>
        </div>
        <MetricChart points={[]} win={win} interval_ms={60_000} direction="above" height={280} full loading label={`${id}, loading`} />
      </div>
    </div>
  );
}

/**
 * The watch a link names in another workspace, read only and whole enough to
 * judge from: its state, value, line and source, the last 7 days drawn, and
 * its issue. The switch below it is the way to change anything.
 */
type ElsewhereIssue = { short_id: string; title?: string; last_transition?: string | null; last_transition_at?: number | null };

function ElsewherePreview({ watch, issue }: { watch: OpsWatch; issue: ElsewhereIssue | null }) {
  const now = useCoarseNow(30_000);
  const series = useWatchSeries(watch._id, ELSEWHERE_SPEC, DETAIL_BUCKETS);
  // The change reads the same card-size pair the watch page and the overview read (rangeChange), so the preview says the number they say.
  const changeCur = useWatchSeries(watch._id, ELSEWHERE_SPEC, CARD_BUCKETS);
  const changePrev = useWatchSeries(watch._id, ELSEWHERE_PREV_SPEC, CARD_BUCKETS);
  const points = useMemo(() => chartPoints(series, watch.points), [series, watch.points]);
  const win = rangeWindow("7d", points, now);
  const visible = points.filter((p) => p.at >= win.from && p.at <= win.to);
  const st = series ? stats(visible) : null;
  const integral = measuresCount(watch.points, visible);
  const fmt = (v: number) => formatMeasure(v, watch.unit, integral);
  const change = rangeChange(changeCur, changePrev, watch.points, "7d", now);
  // The alert's start the monitor announced, the same one the watch page and the overview time from.
  const since = currentEpisodeSince(watch, issue ? { last_transition: issue.last_transition ?? undefined, last_transition_at: issue.last_transition_at ?? undefined } : null);
  return (
    <div className="mx-page mx-elsewhere" data-metric-elsewhere={watch.short_id}>
      <div className="mx-head">
        <div className="mx-head-main">
          <h1>{watch.name}</h1>
          <div className="mx-facts">
            <HealthPill watch={watch} now={now} since={since} />
            {watch.source_name && <span className="ops-dim">{watch.source_name}</span>}
            <span className="ops-dim">{KIND_LABEL[watch.query_kind] ?? watch.query_kind}</span>
            <span className="ops-dim">every {intervalLabel(watch.interval_ms)}</span>
            {issue && <span className="ops-mono ops-dim" title={issue.title}>{issue.short_id}</span>}
          </div>
        </div>
      </div>
      <div className="mx-stats" style={statCols(5)}>
        <Stat label="Now" value={watch.last_value === null || watch.last_value === undefined ? "–" : formatValue(watch.last_value, watch.unit)} tone={watchHealth(watch) === "alert" ? "bad" : undefined} sub={watch.last_at ? relTimeShort(watch.last_at, now) : undefined} />
        <Stat
          label={<><span className="mx-stat-wide">Last 7d </span>vs prior 7d</>}
          value={change ? (change.pct === null ? `${change.change >= 0 ? "+" : "-"}${fmt(Math.abs(change.change))}` : formatPct(change.pct)) : "–"}
          tone={change ? (((t) => (t === "flat" ? undefined : t))(changeTone(watch, change.change))) : undefined}
          sub={change ? <><span className="mx-stat-wide">mean </span>{fmt(change.now)} vs {fmt(change.base)}</> : !changeCur || !changePrev ? "reading…" : "no values 7d earlier"}
          data="change"
        />
        <Stat label="Line" value={watch.threshold === undefined ? "none" : `${watch.direction === "above" ? ">" : "<"} ${formatValue(watch.threshold, watch.unit)}`} sub={watch.warn !== undefined ? `warn ${formatValue(watch.warn, watch.unit)}` : undefined} data="line" />
        <Stat label="Range 7d" value={st ? (st.min === st.max ? fmt(st.min) : `${fmt(st.min)} – ${fmt(st.max)}`) : "–"} data="range" minor />
        <Stat label="Mean 7d" value={((m) => (m !== null ? fmt(m) : "–"))(stripMean(st ? st.avg : null, change, "7d", false))} data="mean" minor />
      </div>
      <div className="mx-chart-card">
        <MetricChart
          points={points}
          win={win}
          interval_ms={Math.max(watch.interval_ms, series?.step_ms ?? 0)}
          threshold={watch.threshold}
          warn={watch.warn}
          direction={watch.direction}
          unit={watch.unit}
          height={220}
          full
          paused={watch.status === "paused"}
          loading={!series}
          label={`${watch.name}, ${visible.length} values in the last 7d`}
        />
      </div>
    </div>
  );
}

/** The range and zoom in the address (?range=7d, ?from=&to=), so a view survives a reload and can be shared. */
function useChartWindowParams(): { range: MetricRange; zoom: Win | null; set: (range: MetricRange, zoom: Win | null) => void } {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const r = params.get("range");
  const range: MetricRange = isMetricRange(r) ? r : "all";
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  const zoom = from > 0 && to > from ? { from, to } : null;
  const set = (nextRange: MetricRange, nextZoom: Win | null) => {
    const qs = new URLSearchParams(params.toString());
    if (nextRange === "all") qs.delete("range");
    else qs.set("range", nextRange);
    if (nextZoom) {
      qs.set("from", String(Math.round(nextZoom.from)));
      qs.set("to", String(Math.round(nextZoom.to)));
    } else {
      qs.delete("from");
      qs.delete("to");
    }
    const q = qs.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  return { range, zoom, set };
}

const MUTES = [
  { label: "1 hour", ms: 3600_000 },
  { label: "4 hours", ms: 4 * 3600_000 },
  { label: "1 day", ms: 24 * 3600_000 },
  { label: "7 days", ms: 7 * 24 * 3600_000 },
].filter((m) => m.ms <= MONITOR_LIMITS.mute_max_ms);

function WatchView({ watch }: { watch: OpsWatch }) {
  const now = useCoarseNow(30_000);
  const sources = useOpsSources();
  const source = sources.find((s) => s._id === watch.source_id);
  useSyncOpsGroup(watch.group_id ?? null);
  const group = useOpsGroup(watch.group_id ?? null);
  useSyncOpsGroupTransitions(group?.short_id ?? null, 90);
  const { range, zoom, set } = useChartWindowParams();
  const [compare, setCompare] = useState(true);
  const [preview, setPreview] = useState<Pt[] | null>(null);
  const [ghost, setGhost] = useState<number | undefined>(undefined);

  // The server's answer for the window: the range's, or the zoom's once it
  // lands (the range's frame stays up meanwhile). Until the range's own
  // answer lands on this visit, what the store already holds for it paints
  // under a loading bar (a detail read from an earlier visit, or the
  // overview's card-size one, whichever reaches further back: fullestHeld);
  // with neither, the plot is loading. Nothing that only a live answer can
  // tell (no values held, no values earlier, too few values) is said meanwhile.
  const rangeSpec = useMemo<SeriesSpec>(() => ({ kind: "range", range }), [range]);
  const { series: rangeSeries, live: rangeLive } = useWatchSeriesLive(watch._id, rangeSpec, DETAIL_BUCKETS);
  const heldRange = useHeldSeries(watch._id, rangeSpec);
  const zoomSpec = useMemo<SeriesSpec | null>(() => (zoom ? { kind: "zoom", win: zoom } : null), [zoom]);
  const { series: zoomSeries, live: zoomLive } = useWatchSeriesLive(zoomSpec ? watch._id : null, zoomSpec, DETAIL_BUCKETS);
  const rangeAnswer = rangeLive ? rangeSeries : fullestHeld(rangeSeries, heldRange);
  const shown = zoomSeries ?? rangeAnswer;
  const loading = !shown;
  // The answer on screen is not this window's own live one yet.
  const pending = zoom ? !zoomLive : !rangeLive;
  const refreshing = !loading && pending;
  const points = useMemo(() => (shown ? chartPoints(shown, watch.points) : []), [shown, watch.points]);
  const heldFrom = rangeAnswer?.held_from ?? null;
  const step = Math.max(watch.interval_ms, shown?.step_ms ?? 0);

  // One count of the alert: the episodes the monitor announced. Crossings the values show with no announcement near them are listed as inferred and count toward nothing.
  const { announced, episodes, since } = useWatchEpisodes(watch, group);
  // All runs from the earliest thing known about the watch (its first value, its first announced alert, its issue's first sighting), so the episodes it counts are the issue's.
  const firstAnnounced = announced[0]?.at ?? null;
  const all = useMemo(
    () => (range === "all" && !loading ? allWindow({ heldFrom, firstAnnounced, firstSeen: group?.first_seen ?? null, points, now, step }) : null),
    [range, loading, heldFrom, firstAnnounced, group?.first_seen, points, now, step],
  );
  const base = all?.win ?? rangeWindow(range, points, now);
  // A value or two held weeks before the rest: named on the bar, one press shows the window from it.
  const stray = zoom ? null : all?.stray ?? null;
  const win = zoom ?? base;
  const span = win.to - win.from;
  // The stretch of the window before the first value held, named on the chart.
  const held = all?.stray ? base.from : heldFrom ?? points[0]?.at ?? null;
  const gap = !loading && !pending && (held === null || held - win.from > span / 50) ? { from: win.from, to: Math.min(win.to, held ?? win.to) } : null;
  const episodeBands = useMemo(() => episodes.map((e) => ({ from: e.from, to: e.to ?? now })), [episodes, now]);
  // The period before, from the server, laid over this one.
  const prevSpec = useMemo<SeriesSpec | null>(() => (zoom ? { kind: "zoom", win: { from: zoom.from - (zoom.to - zoom.from), to: zoom.from } } : range === "all" ? null : { kind: "prev", range }), [zoom, range]);
  const { series: prevSeries, live: prevLive } = useWatchSeriesLive(prevSpec ? watch._id : null, prevSpec, DETAIL_BUCKETS);
  const prev = useMemo(() => (prevSeries ? shiftPoints(prevSeries.points, span) : []), [prevSeries, span]);
  // The change stat, one rule at every range (rangeChange), read off the very
  // series the overview's card reads (card size, changeRange: All reads the
  // last 7 days), so the page and the card say the same number whichever
  // answer arrived first. A zoom compares its span with the one before it.
  const cRange = changeRange(range);
  const changeCurSpec = useMemo<SeriesSpec | null>(() => (zoom ? null : { kind: "range", range: cRange }), [zoom, cRange]);
  const changePrevSpec = useMemo<SeriesSpec | null>(() => (zoom ? null : { kind: "prev", range: cRange }), [zoom, cRange]);
  const changeCur = useWatchSeriesLive(changeCurSpec ? watch._id : null, changeCurSpec, CARD_BUCKETS);
  const changePrev = useWatchSeriesLive(changePrevSpec ? watch._id : null, changePrevSpec, CARD_BUCKETS);
  const cspan = zoom ? span : changeSpan(range);

  const visible = useMemo(() => inWindow(points, win).filter((p) => p.at >= win.from && p.at <= win.to), [points, win]);
  const st = loading ? null : stats(visible);
  const change = zoom
    ? (zoomSeries ? periodChange(points, prevSeries?.points ?? null, cspan, win.to) : null)
    : rangeChange(changeCur.series, changePrev.series, watch.points, range, now);
  const changeIs = changeState(change, zoom ? zoomLive && prevLive : changeCur.live && changePrev.live);
  const mean = stripMean(st ? st.avg : null, change, range, !!zoom);
  const named = windowName(win, range === "all" && !zoom);
  const integral = useMemo(() => measuresCount(watch.points, visible), [watch.points, visible]);
  const fmt = (v: number) => formatMeasure(v, watch.unit, integral);
  const health = watchHealth(watch);
  const muted = isMutedAt(watch, now);
  const paused = watch.status === "paused";
  const update = useInboxStore((s) => s.updateOpsWatch);
  const reading = !!watch.history?.reading;
  // A window reaching past the values held reads the source's older values by itself, once per watch and range; the button stays for a read that came back short.
  const backfillable = watch.query_kind !== "insight" && !paused;
  useWatchEffect(() => {
    if (!gap || !backfillable || reading || pending) return;
    const key = `${watch._id}:${range}`;
    if (autoBackfilled.has(key) || (watch.history && Date.now() - watch.history.at < BACKFILL_FRESH_MS)) return;
    autoBackfilled.add(key);
    useInboxStore.getState().loadOpsWatchHistory(watch._id);
  }, [!!gap, backfillable, reading, pending, range, watch._id]);

  // The chart draws the announced transitions' own reads where the series holds no value near them, so a recovery sits on its line.
  const drawnPoints = useMemo(() => (watch.threshold === undefined ? points : withAnnouncedReads(points, announced, step)), [points, announced, step, watch.threshold]);
  const tolerance = Math.max(watch.interval_ms * ((watch.eval_reads ?? 1) + 1), step * 2);
  const transitions = useMemo(() => transitionRows(announced, crossings(points, watch.threshold, watch.direction, true), tolerance), [announced, points, watch.threshold, watch.direction, tolerance]);
  const inWin = episodeSummary(episodes, win, now);

  const taskStatus = useInboxStore((s) => (group?.signal_task_id ? (s.tasks as Record<string, { status?: string }>)[group.signal_task_id]?.status : undefined));
  const stage = group ? fixStage(group, taskStatus) : null;
  const ownMarks = useWatchMarks(watch, group, announced);
  const ships = useShipMarks(win, ownMarks, source, sources);
  // Many ships start hidden, so the values are never read through a barcode; the legend's toggle shows them.
  const [shipsPicked, setShowShips] = useState<boolean | null>(null);
  const showShips = shipsPicked ?? ships.length <= SHIPS_SHOWN_MAX;
  const zoomTo = (w: Win | null) => set(range, w);
  const error = watchErrorText(watch);

  return (
    <div className="mx-page" data-metric-page={watch.short_id} data-health={health}>
      <div className="mx-head">
        <div className="mx-head-main">
          <h1>{watch.name}</h1>
          <div className="mx-facts">
            {health === "series" && !muted ? (
              <button type="button" className="mx-health mx-noline" style={{ ["--ink" as string]: HEALTH_LOOK.series.ink }} onClick={focusLine} data-health="series" data-add-line><span>No line</span><span>Add line</span></button>
            ) : <HealthPill watch={watch} now={now} since={since} />}
            {source && (
              <Link href={opsHref.tab("metrics", { source: source.name })} className="inline-flex items-center gap-1 hover:text-sol-text">
                <ProviderIcon provider={source.provider} />{source.name}
              </Link>
            )}
            <span className="ops-dim">{KIND_LABEL[watch.query_kind] ?? watch.query_kind}</span>
            <span className="ops-dim">every {intervalLabel(watch.interval_ms)}</span>
            {(watch.eval_reads ?? 1) > 1 && <span className="ops-dim">{watch.eval_reads} reads in a row</span>}
            {group && <Link href={opsHref.issue(group.short_id)} className="ops-mono hover:underline">{group.short_id}</Link>}
          </div>
        </div>
        <div className="mx-head-actions">
          {watch.threshold !== undefined && <MuteControl watch={watch} muted={muted} onMute={(until) => update(watch._id, { muted_until: until })} />}
          {group && stage && <FixAction group={group} source={source} stage={stage} now={now} />}
        </div>
      </div>

      {error && !paused && <ReadError watch={watch} source={source} error={error} now={now} />}

      <div className="mx-stats" data-loading={pending ? "" : undefined} style={statCols(5 + (watch.threshold !== undefined ? 1 : 0) + (since !== null ? 1 : 0))}>
        <Stat label="Now" value={watch.last_value === null ? "–" : formatValue(watch.last_value, watch.unit)} tone={health === "alert" ? "bad" : undefined} sub={watch.last_at ? relTimeShort(watch.last_at, now) : undefined} />
        <Stat
          label={<><span className="mx-stat-wide">{zoom ? "Zoom " : `Last ${spanLabel(cspan)} `}</span>vs prior {spanLabel(cspan)}</>}
          value={change ? (change.pct === null ? `${change.change >= 0 ? "+" : "-"}${fmt(Math.abs(change.change))}` : formatPct(change.pct)) : "–"}
          tone={change ? (((t) => (t === "flat" ? undefined : t))(changeTone(watch, change.change))) : undefined}
          sub={change ? <><span className="mx-stat-wide">mean </span>{fmt(change.now)} vs {fmt(change.base)}</> : changeIs === "reading" ? "reading…" : `no values ${spanLabel(cspan)} earlier`}
          title={`The mean of the ${zoom ? "zoomed span" : `last ${spanLabel(cspan)}`} against the mean of the ${spanLabel(cspan)} before it`}
          data="change"
        />
        <Stat label="Line" value={watch.threshold === undefined ? "none" : `${watch.direction === "above" ? ">" : "<"} ${formatValue(watch.threshold, watch.unit)}`} sub={watch.warn !== undefined ? `warn ${formatValue(watch.warn, watch.unit)}` : undefined} data="line" />
        <Stat label={`Range ${named.short}`} value={st ? (st.min === st.max ? fmt(st.min) : `${fmt(st.min)} – ${fmt(st.max)}`) : "–"} data="range" minor />
        <Stat label="Mean" value={mean !== null ? fmt(mean) : "–"} sub={st?.uneven ? "time-weighted" : undefined} title={st?.uneven ? "Each value counts for as long as it stood, so a day of polls does not outweigh weeks of weekly values" : undefined} data="mean" minor />
        {watch.threshold !== undefined && (
          <Stat
            label={`Episodes ${named.short}`}
            value={inWin.count ? String(inWin.count) : "none"}
            tone={inWin.count ? "bad" : undefined}
            sub={inWin.count ? `${durationShort(inWin.total)} alerting` : undefined}
            data="episodes"
            minor
          />
        )}
        {since !== null && <Stat label="This episode" value={durationShort(now - since)} tone="bad" sub={`since ${stampLabel(since)}`} data="current" minor />}
      </div>

      <div className="mx-chart-card">
        <div className="mx-chart-bar">
          <span className="mx-seg" role="group" aria-label="Time range">
            {METRIC_RANGES.map((r) => (
              <button key={r.key} type="button" aria-pressed={!zoom && range === r.key} onClick={() => set(r.key, null)} data-metric-range={r.key}>{r.label}</button>
            ))}
          </span>
          {zoom && (
            <button type="button" className="ops-btn" onClick={() => zoomTo(null)} data-metric-unzoom>
              {stampLabel(zoom.from)} – {stampLabel(zoom.to)} ✕
            </button>
          )}
          {stray && (
            <button type="button" className="mx-state" style={{ ["--ink" as string]: "var(--sol-text-muted)" }} onClick={() => zoomTo({ from: stray.at - (now - stray.at) * 0.02, to: now })} title="Show the window from the earliest value" data-metric-stray={stray.count}>
              {stray.count === 1 ? "1 value" : `${stray.count} values`} {shortDate(stray.at)}
            </button>
          )}
          {prevSpec && (
            <button type="button" className="mx-state" aria-pressed={compare} onClick={() => setCompare(!compare)} style={{ ["--ink" as string]: "var(--sol-text-muted)" }} data-metric-compare>
              vs previous {spanLabel(span)}
            </button>
          )}
          <span className="flex-1" />
          <span className="mx-legend" aria-hidden>
            <span><i />value</span>
            {watch.threshold !== undefined && <span><i data-k="past" />past the line</span>}
            {shown?.step_ms ? <span><i data-k="range" />min–max per {spanLabel(shown.step_ms)}</span> : null}
            {compare && prev.length > 0 && <span><i data-k="prev" />previous</span>}
            {watch.threshold !== undefined && <span><i data-k="line" />line</span>}
            {watch.warn !== undefined && <span><i data-k="warn" />warn</span>}
            {preview && <span><i data-k="preview" />query run</span>}
            {ships.length > 0 && <button type="button" aria-pressed={showShips} onClick={() => setShowShips(!showShips)} data-metric-ships={ships.length}><i data-k="deploy" />ships {ships.length}</button>}
          </span>
          <button
            type="button"
            className="ops-btn"
            title={watch.history?.note ?? "Read the past values the source holds"}
            disabled={reading}
            onClick={() => useInboxStore.getState().loadOpsWatchHistory(watch._id)}
            data-ops-load-history
          >
            {reading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
            History
          </button>
        </div>
        <MetricChart
          points={drawnPoints}
          win={win}
          interval_ms={step}
          threshold={watch.threshold}
          warn={watch.warn}
          direction={watch.direction}
          unit={watch.unit}
          marks={ownMarks}
          ships={showShips ? ships : undefined}
          compare={compare ? prev : undefined}
          height={280}
          full
          paused={paused}
          loading={loading}
          stale={refreshing}
          preview={preview ?? undefined}
          ghostLine={ghost}
          onZoom={zoomTo}
          onResetZoom={() => zoomTo(null)}
          onThreshold={(v) => update(watch._id, { threshold: v })}
          poll_ms={watch.interval_ms}
          label={`${watch.name}, ${visible.length} values ${named.within}`}
          gap={gap}
          episodes={watch.threshold !== undefined ? episodeBands : undefined}
          transitions={watch.threshold !== undefined ? transitions : undefined}
          gapAction={gap && backfillable ? (
            reading || !watch.history ? (
              <span className="ops-dim inline-flex items-center gap-1" data-gap-reading><Loader2 className="w-3.5 h-3.5 animate-spin" />reading older values</span>
            ) : (
              <button type="button" className="ops-btn" title={watch.history.note} onClick={() => useInboxStore.getState().loadOpsWatchHistory(watch._id)} data-gap-backfill>
                <History className="w-3.5 h-3.5" />{watch.history.note ? "Read again" : "Read older values"}
              </button>
            )
          ) : null}
        />
      </div>

      <div className="mx-cols">
        <div className="mx-col-a">
          <TransitionsCard watch={watch} rows={transitions} win={win} within={named.within} since={since} now={now} provisional={refreshing} onZoom={(at) => zoomTo(windowAround(at, span, now))} />
          {group && stage && <FixPanel group={group} source={source} stage={stage} episodes={episodes} now={now} />}
          <DistributionCard watch={watch} history={visible} named={named} loading={loading || (pending && visible.length < 3)} provisional={refreshing} onDraft={setGhost} />
          <QueryEditor watch={watch} source={source} onPreview={setPreview} highlight={highlightSql} />
        </div>
        <div className="mx-col-c">
          <WatchSettings watch={watch} source={source} removeLedger={removeWatchLedger(watch, group?.short_id ?? null)} history={visible} within={named.within} onDraft={setGhost} />
          <SourceCard watch={watch} source={source} heldFrom={heldFrom} now={now} />
        </div>
      </div>
    </div>
  );
}

/** The watch's story as chart markers, from the store: announced transitions, the problem task, the fix session, its commit, the resolve. */
function useWatchMarks(watch: OpsWatch, group: OpsGroup | undefined, transitions: TransitionRow[]) {
  const taskSig = useInboxStore((s) => {
    const t = group?.signal_task_id ? (s.tasks as Record<string, any>)[group.signal_task_id] : undefined;
    return t ? JSON.stringify([t.short_id, t.status, t.created_at, t.closed_at, t.landed?.sha]) : "";
  });
  return useMemo(() => {
    const task = group?.signal_task_id && taskSig ? (useInboxStore.getState().tasks as Record<string, any>)[group.signal_task_id] : null;
    return watchMarks({ transitions, unit: watch.unit, group: group ?? null, task: task ? { ...task, _id: group!.signal_task_id! } : null, issueHref: group ? opsHref.issue(group.short_id) : undefined });
  }, [transitions, watch.unit, group, taskSig]);
}

const deploySig = (e: OpsEvent) => (e.kind === "deploy" ? `${e.created_at}|${e.sha ?? ""}|${e.title}` : "");
const landedSig = (t: { landed?: { sha: string; at: number }; project_id?: string }) => (t.landed ? `${t.landed.sha}|${t.landed.at}|${t.project_id ?? ""}` : "");

type LandedTask = ShipTask & { project_id?: string; landed: ShipTask["landed"] & { repository?: string } };

/**
 * The ships in the window that can move this watch, from the store: deploys
 * recorded by its source and the sources tied to it, and changes landed by
 * tasks of the same project or repository (relatedShips). The watch's own
 * fix commit is already one of its own markers, so it is not drawn twice.
 */
function useShipMarks(win: Win, own: ChartMark[], source: OpsSource | undefined, sources: OpsSource[]): ChartMark[] {
  const events = useWorkspaceCollection<OpsEvent>("opsEvents", deploySig);
  const tasks = useWorkspaceCollection<Omit<LandedTask, "landed"> & { landed?: LandedTask["landed"] }>("tasks", landedSig);
  return useMemo(() => {
    const deploys = events.filter((e) => e.kind === "deploy").map((e) => ({ at: e.created_at, title: e.title, sha: e.sha, url: e.url, source: e.data?.source_name, source_id: e.source_id }));
    const landed = tasks.filter((t): t is LandedTask => !!t.landed);
    const related = relatedShips({ source, sources, deploys, tasks: landed });
    const skip = own.filter((m) => m.kind === "ship").map((m) => m.label.replace(/^Landed /, ""));
    return shipMarks({ deploys: related.deploys, tasks: related.tasks, win, skip });
  }, [events, tasks, win, own, source, sources]);
}

/** One Mute button with its durations in a menu; while muted, when it ends and Unmute. */
function MuteControl({ watch, muted, onMute }: { watch: OpsWatch; muted: boolean; onMute: (until: number | null) => void }) {
  if (muted) {
    return (
      <span className="mx-muted" data-watch-muted>
        <BellOff className="w-3.5 h-3.5" />
        <span>Muted until {stampLabel(watch.muted_until!)}</span>
        <button type="button" className="ops-btn" onClick={() => onMute(null)} data-watch-unmute>Unmute</button>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ops-btn" aria-label="Mute alerts" data-watch-mute><BellOff className="w-3.5 h-3.5" />Mute</button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Hold alerts for</DropdownMenuLabel>
        {MUTES.map((m) => <DropdownMenuItem key={m.label} onSelect={() => onMute(Date.now() + m.ms)} data-watch-mute-for={m.ms}>{m.label}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A read that failed: what failed (the reader and its error), how often, and the two things to do about it. */
function ReadError({ watch, source, error, now }: { watch: OpsWatch; source: OpsSource | undefined; error: string; now: number }) {
  const { asking, readNow } = useReadNow([watch]);
  return (
    <div className="mx-error" role="alert" data-watch-error>
      <AlertTriangle className="w-3.5 h-3.5" />
      <span className="flex-1 min-w-0" style={{ overflowWrap: "anywhere" }}>
        <b className="font-medium">{error}</b>
        <span className="ops-dim"> · {watch.missed && watch.missed > 1 ? `${watch.missed} reads failed in a row` : "last read failed"} · {watch.last_at ? `last value ${relTimeShort(watch.last_at, now)}` : "never read"}</span>
      </span>
      <button type="button" className="ops-btn" disabled={asking} onClick={readNow} data-watch-read-now>
        {asking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Read now
      </button>
      {source && <Link href={opsHref.home({ source: source.name })} className="ops-btn" data-watch-check-source>Check {source.name}</Link>}
    </div>
  );
}

function SourceCard({ watch, source, heldFrom, now }: { watch: OpsWatch; source: OpsSource | undefined; heldFrom: number | null; now: number }) {
  const paused = watch.status === "paused";
  return (
    <div className="ops-card mt-3.5">
      <div className="ops-card-head">Source</div>
      <div className="ops-card-body">
        <dl className="mx-kv">
          <dt>source</dt>
          <dd className="inline-flex items-center gap-1.5">{source ? <><ProviderIcon provider={source.provider} />{source.name} <span className="ops-dim">{SOURCE_PROVIDER_LABEL[source.provider]}</span></> : <span className="ops-dim">removed</span>}</dd>
          {source && source.status !== "active" && <><dt>status</dt><dd style={{ color: "var(--sol-orange)" }}>{source.status}{source.last_error ? `: ${source.last_error}` : ""}</dd></>}
          <dt>polls</dt>
          <dd>every {intervalLabel(watch.interval_ms)}{paused ? ", paused" : ""}</dd>
          <dt>last value</dt>
          <dd>{watch.last_at ? stampLabel(watch.last_at) : "never"}</dd>
          <dt>history</dt>
          <dd className="ops-num">{heldFrom !== null ? `since ${stampLabel(heldFrom)}` : "–"}</dd>
          {watch.history && !watch.history.reading && (
            <><dt>backfill</dt><dd className="ops-dim" title={watch.history.note}>{watch.history.added ? `+${watch.history.added} values` : "none"}, {relTimeShort(watch.history.at, now)}</dd></>
          )}
        </dl>
      </div>
    </div>
  );
}

/** The settings' line field, scrolled to and focused: where a watch with no line gets one. */
function focusLine() {
  const el = document.getElementById("mx-line");
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
  (el as HTMLInputElement | null)?.focus({ preventScroll: true });
}

/** The stats strip's columns: all in one row when wide, an even split into two rows when the page narrows (metrics.css). */
function statCols(n: number): CSSProperties {
  const half = Math.ceil(n / 2);
  // On a phone two to a row, the Mean cell last (metrics.css): it takes the whole row when the count is odd.
  return { ["--n" as string]: n, ["--half" as string]: half, ["--last-span" as string]: 2 * half - n + 1, ["--phone-span" as string]: n % 2 ? 2 : 1 };
}

function Stat({ label, value, tone, sub, data, minor, title }: { label: ReactNode; value: string; tone?: "bad" | "good"; sub?: ReactNode; data?: string; /** Left off a phone's first screen. */ minor?: boolean; title?: string }) {
  return (
    <div className="mx-stat" data-stat={data} data-minor={minor ? "" : undefined} title={title}>
      <div className="mx-stat-label">{label}</div>
      <div className="mx-stat-value" data-tone={tone}>{value}{sub && <small>{sub}</small>}</div>
    </div>
  );
}

/**
 * Each transition in the chart's window, newest first; a row zooms the chart
 * to its moment, and the ones outside the window are one press away, marked
 * as outside it. Announced ones are the alert's; inferred ones (read off the
 * values, never announced) are dimmed and counted apart.
 */
function TransitionsCard({ watch, rows: oldestFirst, win, within, since, now, provisional = false, onZoom }: { watch: OpsWatch; rows: TransitionRow[]; win: Win; within: string; /** When the running alert began (currentEpisodeSince); null when not alerting. */ since: number | null; now: number; /** Read off a stored answer while the window's own is on its way: the counts may still move. */ provisional?: boolean; onZoom: (at: number) => void }) {
  const rows = useMemo(() => [...oldestFirst].reverse(), [oldestFirst]);
  const [showInferred, setShowInferred] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (watch.threshold === undefined) return null;
  const kept = showInferred ? rows : rows.filter((r) => !r.inferred);
  const { inside, outside } = transitionsIn(kept, win);
  const announcedIn = transitionsIn(rows.filter((r) => !r.inferred), win).inside.length;
  const inferredIn = transitionsIn(rows.filter((r) => r.inferred), win).inside.length;
  // The running alert stays in view whatever the range (as a monitor's status does): its crossing pinned first when it began before the window.
  const running = runningCrossing(oldestFirst, since);
  const pinned = running && !showAll && running.at < win.from ? running : null;
  const list = pinned ? [pinned, ...inside.filter((r) => r !== pinned)] : showAll ? kept : inside;
  const sent = deliveriesByRow(oldestFirst, watch.deliveries, Math.max(watch.interval_ms * 2, 120_000));
  // An announced alert routing reached nobody on: routed now, but not then (the deliveries kept reach back past it, or are not full).
  const unrouted = (r: TransitionRow) => routedSilently(r, watch);
  // The duration of an announced crossing runs to the next announced recovery.
  const until = (r: TransitionRow) => {
    const i = oldestFirst.indexOf(r);
    return oldestFirst.slice(i + 1).find((x) => !x.inferred && x.kind === "recovered")?.at ?? null;
  };
  const isOut = (r: TransitionRow) => r.at < win.from || r.at > win.to;
  return (
    <div className="ops-card" data-watch-transitions data-provisional={provisional ? "" : undefined} aria-busy={provisional || undefined}>
      <div className="ops-card-head mx-trans-head">
        <span className="mx-trans-title">Transitions <span className="ops-dim ops-num" data-transitions-count={announcedIn}>{announcedIn}</span></span>
        <span className="mx-trans-toggles">
          {/* Each toggle adds its rows to the list (tagged on the row) and says so in its own state: + to show them, a check once they are listed. */}
          {inferredIn > 0 && (
            <button type="button" className="mx-state" aria-pressed={showInferred} onClick={() => setShowInferred(!showInferred)} style={{ ["--ink" as string]: "var(--sol-cyan)" }} title="Crossings the values show that the monitor never announced" data-transitions-inferred>
              {showInferred ? <Check aria-hidden className="w-3 h-3" /> : <Plus aria-hidden className="w-3 h-3" />}not announced<b>{inferredIn}</b>
            </button>
          )}
          {outside > 0 && (
            <button type="button" className="mx-state" aria-pressed={showAll} onClick={() => setShowAll(!showAll)} style={{ ["--ink" as string]: "var(--sol-cyan)" }} data-transitions-outside={outside}>
              {showAll ? <Check aria-hidden className="w-3 h-3" /> : <Plus aria-hidden className="w-3 h-3" />}outside range<b>{outside}</b>
            </button>
          )}
        </span>
      </div>
      {list.length === 0 ? (
        <div className="ops-card-body ops-dim text-[12px]">{outside ? `None ${within}` : inferredIn ? "None announced" : "Never past the line"}</div>
      ) : (
        <table className="mx-trans">
          <tbody>
            {list.slice(0, 60).map((r) => {
              const end = !r.inferred && r.kind === "crossed" && r !== pinned ? until(r) : null;
              const told = !r.inferred ? sent.get(rowKey(r)) : undefined;
              return (
                <Fragment key={`${r.at}-${r.kind}-${r.inferred ? "i" : "a"}`}>
                <tr onClick={() => onZoom(r.at)} tabIndex={0} title={r.inferred ? "Read off the values; no alert was sent" : undefined} onKeyDown={(e) => { if (e.key === "Enter") onZoom(r.at); }} data-transition={r.kind} data-inferred={r.inferred ? "" : undefined} data-outside={isOut(r) && r !== pinned ? "" : undefined} data-running={r === pinned ? "" : undefined}>
                  <td data-kind={r.kind}>{r.kind === "crossed" ? "crossed" : "recovered"}{r.inferred && <span className="mx-inferred">not announced</span>}{r === pinned && <span className="mx-inferred">before range</span>}</td>
                  <td>{r.value === null ? "" : formatValue(r.value, watch.unit)}</td>
                  <td className="ops-dim">{stampLabel(r.at)}</td>
                  <td className="ops-dim" style={{ textAlign: "right" }}>{!r.inferred && r.kind === "crossed" ? (end ? `for ${durationShort(end - r.at)}` : watch.state === "alert" || r === pinned ? `ongoing, ${durationShort(now - r.at)}` : "") : ""}</td>
                </tr>
                {told ? (
                  <tr className="mx-sent" data-transition-sent={told.length}>
                    <td colSpan={4}><SentList told={told} /></td>
                  </tr>
                ) : unrouted(r) ? (
                  <tr className="mx-sent" data-transition-sent="0">
                    <td colSpan={4}><span className="mx-sent-list">no routes then</span></td>
                  </tr>
                ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** What one alert did: each person, role, channel and fix it reached, the ones that could not go out in orange with why. */
function SentList({ told }: { told: AlertDelivery[] }) {
  return (
    <span className="mx-sent-list">
      {told.map((d, i) => {
        const what = `${d.kind === "still" ? "again " : ""}${d.to}${d.note ? ` (${d.note})` : ""}`;
        return d.href
          ? <Link key={i} href={d.href} data-ok={String(d.ok)} title={stampLabel(d.at)}>{d.ok ? "→ " : "✕ "}{what}</Link>
          : <span key={i} data-ok={String(d.ok)} title={stampLabel(d.at)}>{d.ok ? "→ " : "✕ "}{what}</span>;
      })}
    </span>
  );
}

const SQL_KEYWORDS = /^(select|from|where|and|or|not|group|by|order|limit|as|on|join|left|right|inner|outer|having|interval|day|hour|minute|week|month|in|is|null|case|when|then|else|end|distinct|count|countif|sum|avg|min|max|uniq|now|today|toStartOfDay|toDate|desc|asc|between|like|ilike)$/i;

/** HogQL lit by token: keywords, strings, numbers and calls. Text only, never markup from the query. */
function highlightSql(sql: string) {
  const parts = sql.split(/('(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g);
  return parts.map((p, i) => {
    if (!p) return null;
    if (p.startsWith("'")) return <span key={i} className="s">{p}</span>;
    if (/^\d/.test(p)) return <span key={i} className="n">{p}</span>;
    if (/^[A-Za-z_]/.test(p)) {
      const call = parts[i + 1]?.startsWith("(");
      if (SQL_KEYWORDS.test(p) && !call) return <span key={i} className="k">{p}</span>;
      if (call) return <span key={i} className="f">{p}</span>;
    }
    return p;
  });
}

/** A day as the bar names it: "Sep 6". */
function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
