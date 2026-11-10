// The Metrics tab: every watched metric (X7) at a glance. A strip of states
// that filter (alert first), one time window every chart shares, search,
// sort and grouping, and two layouts: cards with a chart each, or a dense
// monitor table. Every filter lives in the address, so a view survives a
// reload and can be shared. Charts read the watch's whole history for the
// window from the server (metrics.seriesMany); a watch holding less than the
// window draws just the stretch it holds (a lone stray value before a break
// does not stretch it) and names where it starts on its axis. A failing read
// shows its error on the card with Read now; several watches on one source
// failing the same way roll up into one row. A card or row opens the watch's
// page. j and k move, Enter opens, N makes a new watch. A series with no
// line says so in the table and offers one. The failing-reads row opens the
// connector's health or starts a fix session on them. With no watches, a
// PostHog source is offered a starter set read before it is added; an error,
// SDK or CI source is offered the series codecast already counts for it,
// each one press from being watched.
import { useContext, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, LayoutGrid, Loader2, Plus, RefreshCw, Rows3, Wand2 } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { MERGES_NEVER } from "../consequential/lineStartLedger";
import { fixSessionPath } from "./startFix";
import { folderName } from "./issueFix";
import { KeyCap } from "../KeyCap";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useEventListener } from "../../hooks/useEventListener";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOpsGroups, useOpsSources, useOpsWatches } from "../../hooks/useSyncOps";
import { WatchSeriesFeeders, useWatchSeriesMap } from "../../hooks/useSyncOpsMetrics";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { relTimeShort } from "../../lib/utils";
import { HealthPill, MetricChart } from "./MetricChart";
import { SparkLine } from "../Spark";
import {
  HEALTH_LOOK, METRIC_RANGES, WATCH_STATES, WATCH_STATE_LOOK, blindWatchIds, watchStateCounts, WATCH_GROUPS, WATCH_SORTS, durationShort, filterWatches, fitStart, formatPct, formatValue, groupWatches, inWindow, isMutedAt, metricsQueryParams,
  parseMetricsQuery, rangeWindow, sortWatches, spanLabel, spanOf, stampLabel, watchHealth, type MetricRange, type MetricsQuery, type Win,
} from "./metricModel";
import { cardWindow, changeAmount, changeTone, chartPoints, rangeChange, changeRange, changeSpan, type WindowDelta, type OpsWatchSeries, type SeriesPt } from "./metricSeries";
import { currentEpisodeSince, errorRollups, readerFixPrompt, watchErrorText, type ErrorRollup } from "./metricEvents";
import { intervalLabel } from "./metricEditing";
import { opsHref } from "./opsPaths";
import { OpsFeedEmpty, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, SourceHealthContext, StatusPill, useOpsFeed } from "./parts";
import { NewWatchSheet } from "./WatchEditor";
import { watchKindsOf } from "./watchQuery";
import { StarterWatches } from "./StarterWatches";
import { VolumeStarter } from "./VolumeStarter";
import { useReadNow } from "./useReadNow";
import { triage } from "./issueUndo";
import type { OpsGroup, OpsSource, OpsWatch } from "./opsTypes";
import "./metrics.css";
import { useChannelOptions } from "./alertRouting";
import { notifySummary, notifyTargets } from "./alertRoutingModel";
import { useOwnerOptions } from "./issueAssign";

/** A watch's page opened on the overview's range, so the change it reads is the one the card showed. */
function watchHref(shortId: string, range: MetricRange): string {
  return range === "all" ? opsHref.metric(shortId) : `${opsHref.metric(shortId)}?range=${range}`;
}

/** The overview's filters, read from and written to the address. */
function useMetricsQuery(): [MetricsQuery, (patch: Partial<MetricsQuery>) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const query = useMemo(() => parseMetricsQuery((k) => params.get(k)), [params]);
  const set = (patch: Partial<MetricsQuery>) => {
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(metricsQueryParams({ ...query, ...patch }))) {
      if (v) qs.set(k, v);
      else qs.delete(k);
    }
    const q = qs.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  return [query, set];
}

/** What one watch draws in a window: the server's history for it, else the row's own newest values. `step` is the spacing its line expects. */
type Drawn = { win: Win; fitted: number | null; points: SeriesPt[]; visible: SeriesPt[]; step: number };

function drawnFor(w: OpsWatch, series: OpsWatchSeries | undefined, win: Win): Drawn {
  const points = chartPoints(series, w.points);
  const step = Math.max(w.interval_ms, series?.step_ms ?? 0);
  // The card fits the stretch the watch really holds: a lone value weeks before the rest does not widen it.
  const fit = cardWindow(win, fitStart(points.filter((p) => p.at >= win.from), step));
  return { ...fit, points, step, visible: inWindow(points, fit.win).filter((p) => p.at >= fit.win.from && p.at <= fit.win.to) };
}

export function MetricsTab({ source }: { source: string | null }) {
  const all = useOpsWatches();
  const feed = useOpsFeed("watches");
  const groups = useOpsGroups();
  const sources = useOpsSources();
  const now = useCoarseNow(60_000);
  const router = useRouter();
  const [query, setQuery] = useMetricsQuery();
  const { health, sort, group: grouping, range, layout } = query;
  // Typed locally and written to the address as it changes.
  const [search, setSearch] = useState(query.q);
  const [creating, setCreating] = useState(false);
  const [cursor, setCursor] = useState(-1);
  useWatchEffect(() => {
    if (search === query.q) return;
    const id = setTimeout(() => setQuery({ q: search }), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- settles on the text alone
  }, [search]);

  const scoped = useMemo(() => (source ? all.filter((w) => w.source_name === source) : all), [all, source]);
  // The home band's states and counts (metricModel watchState): a watch blind behind its source's failing reader is Blind on both.
  const sourceHealth = useContext(SourceHealthContext);
  const blind = useMemo(() => blindWatchIds(scoped, (id) => sourceHealth?.get(id)), [scoped, sourceHealth]);
  const counts = useMemo(() => watchStateCounts(scoped, blind), [scoped, blind]);
  const groupShort = useMemo(() => new Map(groups.map((g) => [g._id, g.short_id])), [groups]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g._id, g])), [groups]);
  const sinceOf = (w: OpsWatch) => currentEpisodeSince(w, w.group_id ? groupById.get(w.group_id) : null);
  const rollups = useMemo(() => errorRollups(scoped), [scoped]);
  const providerOf = useMemo(() => new Map(sources.map((s) => [s._id, s.provider])), [sources]);
  const seriesMap = useWatchSeriesMap(range);
  const changeMap = useWatchSeriesMap(changeRange(range));
  const prevMap = useWatchSeriesMap(changeRange(range), "prev");
  // One change on every card, row and sort: the newest span's mean against the period before it (periodChange), read off the same range as the watch page reads it (All: the 7d range).
  const changeOf = useMemo(() => {
    const memo = new Map<string, WindowDelta | null>();
    return (w: OpsWatch) => {
      if (!memo.has(w._id)) memo.set(w._id, rangeChange(changeMap.get(w._id), prevMap.get(w._id), w.points, range, now));
      return memo.get(w._id)!;
    };
  }, [changeMap, prevMap, range, now]);
  const rows = useMemo(() => sortWatches(filterWatches(scoped, { health, search, blind }), sort, changeOf), [scoped, health, search, sort, changeOf, blind]);
  const grouped = useMemo(() => groupWatches(rows, grouping), [rows, grouping]);
  const flat = useMemo(() => grouped.flatMap((g) => g.rows), [grouped]);
  const win = useMemo<Win>(() => {
    if (range !== "all") return rangeWindow(range, [], now);
    const held = [...seriesMap.values()].map((s) => s.held_from).filter((x): x is number => x !== null);
    const rowSpan = spanOf(scoped, now);
    return { from: Math.min(rowSpan.from, ...held), to: now };
  }, [range, scoped, seriesMap, now]);
  const ids = useMemo(() => scoped.map((w) => w._id), [scoped]);
  const hosts = useMemo(() => sources.filter((s) => watchKindsOf(s.provider).length > 0), [sources]);
  const scopedSource = source ? sources.find((s) => s.name === source) : undefined;
  const canCreate = scopedSource ? watchKindsOf(scopedSource.provider).length > 0 : hosts.length > 0;

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal() || creating) return;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      setCursor((c) => Math.max(0, Math.min(flat.length - 1, c + (e.key === "j" ? 1 : -1))));
    } else if (e.key === "Enter" && flat[cursor]) {
      e.preventDefault();
      router.push(watchHref(flat[cursor].short_id, range));
    } else if (e.key === "n" && canCreate) {
      e.preventDefault();
      setCreating(true);
    }
  });

  const sheet = creating && <NewWatchSheet sources={sources} initialSource={source} onClose={() => setCreating(false)} />;

  if (scoped.length === 0) {
    return (
      <div className="ops-pad">
        <MetricsEmpty feedEmpty={<OpsFeedEmpty feeds={[feed]} what="metric watches" title="No watches" />} feedReady={!!feed?.ready || all.length > 0} failed={!!feed?.error} source={scopedSource} hosts={hosts} onCreate={canCreate ? () => setCreating(true) : null} />
        {sheet}
      </div>
    );
  }

  const cursorId = flat[cursor]?._id;
  const drawn = (w: OpsWatch) => drawnFor(w, seriesMap.get(w._id), win);
  return (
    <div className="ops-pad" data-metrics-overview>
      <WatchSeriesFeeders ids={ids} range={range} />
      <div className="mx-bar">
        <div className="mx-states" role="group" aria-label="Filter by state">
          {WATCH_STATES.map((h) => (
            <button
              key={h}
              type="button"
              className="mx-state"
              aria-pressed={health === h}
              data-zero={counts[h] ? undefined : ""}
              disabled={!counts[h] && health !== h}
              style={{ ["--ink" as string]: WATCH_STATE_LOOK[h].ink }}
              onClick={() => { setQuery({ health: health === h ? null : h }); setCursor(-1); }}
              data-metrics-state={h}
            >
              <i aria-hidden />{WATCH_STATE_LOOK[h].label}<b>{counts[h]}</b>
            </button>
          ))}
        </div>
        <span className="mx-bar-fill" />
        <input className="mx-search" type="search" placeholder="Filter watches" value={search} onChange={(e) => { setSearch(e.target.value); setCursor(-1); }} aria-label="Filter watches by name" />
        <span className="mx-seg" role="group" aria-label="Time window">
          {METRIC_RANGES.map((r) => <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setQuery({ range: r.key })} data-metrics-range={r.key}>{r.label}</button>)}
        </span>
        <select className="mx-select" value={sort} onChange={(e) => setQuery({ sort: e.target.value as MetricsQuery["sort"] })} aria-label="Sort">
          {WATCH_SORTS.map((s) => <option key={s.key} value={s.key}>Sort: {s.label}</option>)}
        </select>
        <select className="mx-select mx-group-select" value={grouping} onChange={(e) => setQuery({ group: e.target.value as MetricsQuery["group"] })} aria-label="Group">
          {WATCH_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.key === "none" ? "No groups" : `By ${g.label.toLowerCase()}`}</option>)}
        </select>
        <span className="mx-seg" role="group" aria-label="Layout">
          <button type="button" aria-pressed={layout === "cards"} onClick={() => setQuery({ layout: "cards" })} aria-label="Cards" title="Cards"><LayoutGrid className="w-3.5 h-3.5" /></button>
          <button type="button" aria-pressed={layout === "table"} onClick={() => setQuery({ layout: "table" })} aria-label="Table" title="Table" data-metrics-layout="table"><Rows3 className="w-3.5 h-3.5" /></button>
        </span>
        {canCreate && (
          <button type="button" className="ops-btn" data-tone="primary" onClick={() => setCreating(true)} aria-label="New watch" data-metrics-new>
            <Plus className="w-3.5 h-3.5" /><span className="mx-btn-label">New watch</span><KeyCap size="xs">N</KeyCap>
          </button>
        )}
      </div>

      {rollups.length > 0 && (
        <div className="mx-rollups" role="list" aria-label="Failing reads">
          {rollups.map((r) => <RollupRow key={`${r.source_id}|${r.error}`} rollup={r} source={sources.find((s) => s._id === r.source_id)} />)}
        </div>
      )}

      {flat.length === 0 ? (
        <div className="ops-dim text-[12.5px] py-10 text-center">No watch matches <button type="button" className="text-sol-link hover:underline" onClick={() => { setSearch(""); setQuery({ health: null, q: "" }); }}>Clear</button></div>
      ) : (
        grouped.map((g) => (
          <section key={g.key} aria-label={g.label || "Watches"}>
            {g.label && <div className="mx-group-head">{g.label}<span className="ops-dim ops-num">{g.rows.length}</span></div>}
            {layout === "cards" ? (
              <div className="mx-grid-cards">
                {g.rows.map((w) => <WatchCard key={w._id} watch={w} range={range} drawn={drawn(w)} change={changeOf(w)} now={now} since={sinceOf(w)} issue={w.group_id ? groupShort.get(w.group_id) : undefined} provider={providerOf.get(w.source_id)} cursor={w._id === cursorId} />)}
              </div>
            ) : (
              <WatchTable rows={g.rows} range={range} drawn={drawn} changeOf={changeOf} groupById={groupById} win={win} now={now} sinceOf={sinceOf} groupShort={groupShort} providerOf={providerOf} cursorId={cursorId} sort={sort} onSort={(s) => setQuery({ sort: s })} />
            )}
          </section>
        ))
      )}
      <div className="mx-keys mt-4" aria-hidden>
        <KeyCap size="xs">J</KeyCap><KeyCap size="xs">K</KeyCap> move <KeyCap size="xs">↵</KeyCap> open
      </div>
      {sheet}
    </div>
  );
}

/** The newest span's mean against the period before it (periodChange), inked by whether it moved toward the line; nothing without values on both sides. */
function Delta({ watch, d, span, blank }: { watch: OpsWatch; d: WindowDelta | null; span: number; blank?: boolean }) {
  if (!d) return blank ? <span className="mx-delta" data-tone="flat" title={`no values in the ${spanLabel(span)} before`}>–</span> : null;
  const formula = `mean ${formatValue(Math.round(d.now * 100) / 100, watch.unit)} over the last ${spanLabel(span)} vs ${formatValue(Math.round(d.base * 100) / 100, watch.unit)} the ${spanLabel(span)} before`;
  if (d.change === 0) return <span className="mx-delta" data-tone="flat" title={formula}>0%</span>;
  return (
    <span className="mx-delta" data-tone={changeTone(watch, d.change)} title={formula} data-change-pct={d.pct === null ? undefined : Math.round(d.pct * 100)}>
      {d.pct === null ? changeAmount(d.change, d.base, watch.unit) : <>{d.change > 0 ? "▲" : "▼"} {formatPct(d.pct)}</>}
    </span>
  );
}

function lineTag(w: OpsWatch): string | null {
  return w.threshold === undefined ? null : `${w.direction === "above" ? ">" : "<"} ${formatValue(w.threshold, w.unit)}`;
}

function WatchCard({ watch: w, range, drawn, change, now, since, issue, provider, cursor }: { watch: OpsWatch; range: MetricRange; drawn: Drawn; change: WindowDelta | null; now: number; since: number | null; issue?: string; provider?: OpsSource["provider"]; cursor: boolean }) {
  const router = useRouter();
  const h = watchHealth(w);
  const href = watchHref(w.short_id, range);
  const open = () => router.push(href);
  return (
    <div
      className="mx-card"
      data-health={h}
      data-cursor={cursor ? "" : undefined}
      data-watch={w.short_id}
      // The whole card takes a click; its name is the one link a keyboard or a screen reader stops on (the card holds links and buttons).
      onClick={(e) => { if (!(e.target as Element).closest("a, button")) open(); }}
    >
      <div className="mx-card-top">
        <Link href={href} className="mx-name" title={w.name}>{w.name}</Link>
        <HealthPill watch={w} now={now} since={since} />
      </div>
      <div className="mx-value-row">
        <span className="mx-value">{w.last_value === null ? "–" : formatValue(w.last_value, w.unit)}</span>
        <Delta watch={w} d={change} span={changeSpan(range)} />
        {h === "error" && w.last_at && <span className="mx-value-age" data-value-age>last {relTimeShort(w.last_at, now)} ago</span>}
        <span className="flex-1" />
        {lineTag(w) && <span className="mx-line-tag">line {lineTag(w)}</span>}
      </div>
      <MetricChart
        points={drawn.points}
        win={drawn.win}
        interval_ms={drawn.step}
        axisStart={drawn.fitted !== null}
        threshold={w.threshold}
        warn={w.warn}
        direction={w.direction}
        unit={w.unit}
        height={h === "alert" ? 72 : 64}
        paused={h === "paused"}
        label={`${w.name} over ${spanLabel(drawn.win.to - drawn.win.from)}`}
      />
      {w.last_error && w.status !== "paused" && <CardError watch={w} />}
      <div className="mx-foot">
        <span className="mx-src"><ProviderIcon provider={provider ?? "posthog"} /><span className="truncate min-w-0">{w.source_name ?? "removed source"}</span></span>
        <span className="ops-mono">{w.short_id}</span>
        {issue && <Link href={opsHref.issue(issue)} className="ops-mono hover:underline" onClick={(e) => e.stopPropagation()}>{issue}</Link>}
        <span className="flex-1" />
        {!(h === "error" && w.last_at) && <span className="ops-num" title={w.last_at ? new Date(w.last_at).toLocaleString() : undefined}>{w.last_at ? relTimeShort(w.last_at, now) : "never read"}</span>}
      </div>
    </div>
  );
}

const COLUMNS: { label: string; sort?: MetricsQuery["sort"]; num?: boolean; cls?: string }[] = [
  { label: "State", sort: "state" },
  { label: "Watch", sort: "name" },
  { label: "Now", num: true },
  { label: "Change", sort: "change", num: true },
  { label: "Line", num: true, cls: "mx-hide-sm mx-col-3" },
  { label: "", cls: "mx-table-spark mx-hide-sm mx-col-1" },
  { label: "Alerting", sort: "alerting", num: true, cls: "mx-col-0" },
  { label: "Source", sort: "source", cls: "mx-hide-sm mx-col-3" },
  { label: "Every", sort: "interval", num: true, cls: "mx-hide-sm mx-col-4" },
  { label: "Issue", cls: "mx-hide-sm mx-col-2" },
  { label: "Tells", cls: "mx-hide-sm mx-col-4" },
  { label: "Read", sort: "updated", num: true },
];

/** The monitor list: state, name, value, change, line, a spark, how long it has alerted, source, cadence, issue, last read. Every sortable column sorts. */
function WatchTable({ rows, range, drawn, changeOf, groupById, win, now, sinceOf, groupShort, providerOf, cursorId, sort, onSort }: {
  rows: OpsWatch[]; range: MetricRange; drawn: (w: OpsWatch) => Drawn; changeOf: (w: OpsWatch) => WindowDelta | null; groupById: Map<string, OpsGroup>; win: Win; now: number; sinceOf: (w: OpsWatch) => number | null; groupShort: Map<string, string>; providerOf: Map<string, OpsSource["provider"]>; cursorId?: string; sort: MetricsQuery["sort"]; onSort: (s: MetricsQuery["sort"]) => void;
}) {
  const router = useRouter();
  const options = useOwnerOptions();
  const channels = useChannelOptions(rows[0]?.workspace ?? "");
  // The routes column only once some watch tells someone; otherwise it is an empty column.
  const tells = rows.some((w) => w.notify);
  const columns = tells ? COLUMNS : COLUMNS.filter((c) => c.label !== "Tells");
  return (
    <div className="mx-table-wrap">
    <table className="mx-table" data-metrics-table>
      <thead>
        <tr>
          {columns.map((c, i) => (
            <th key={i} scope="col" data-num={c.num ? "" : undefined} className={c.cls} aria-sort={c.sort && c.sort === sort ? "descending" : undefined}>
              {c.sort ? <button type="button" onClick={() => onSort(c.sort!)} data-metrics-sort={c.sort}>{c.label}</button> : c.label || spanLabel(win.to - win.from)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((w) => {
          const issue = w.group_id ? groupShort.get(w.group_id) : undefined;
          const d = drawn(w);
          const since = watchHealth(w) === "alert" ? sinceOf(w) : null;
          const error = w.status !== "paused" ? watchErrorText(w) : null;
          return (
            <tr key={w._id} data-cursor={w._id === cursorId ? "" : undefined} data-watch={w.short_id} onClick={(e) => { if (!(e.target as Element).closest("a")) router.push(watchHref(w.short_id, range)); }}>
              <td>
                {watchHealth(w) === "series" && !isMutedAt(w, now) ? (
                  <Link href={`${watchHref(w.short_id, range)}#mx-line`} className="mx-health mx-noline" style={{ ["--ink" as string]: HEALTH_LOOK.series.ink }} data-health="series" data-add-line>
                    <span>No line</span><span>Add line</span>
                  </Link>
                ) : <HealthPill watch={w} now={now} since={since} />}
              </td>
              <td>
                <Link href={watchHref(w.short_id, range)} className="mx-name" title={w.name}>{w.name}</Link>
                {error && <span className="mx-row-error" data-health={watchHealth(w)} data-watch-error-inline>{error}</span>}
              </td>
              <td data-num="">{w.last_value === null ? "–" : formatValue(w.last_value, w.unit)}</td>
              <td data-num=""><Delta watch={w} d={changeOf(w)} span={changeSpan(range)} blank /></td>
              <td data-num="" className="mx-hide-sm mx-col-3 ops-dim">{lineTag(w) ?? ""}</td>
              {/* A row's line is a plain SVG (the shared SparkLine, as the Overview's watch band draws it), never a chart instance per row. */}
              <td className="mx-table-spark mx-hide-sm mx-col-1"><SparkLine values={d.points.map((p) => p.value)} target={w.threshold ?? null} width={120} height={22} className="max-w-full" tone={w.status === "paused" ? "var(--sol-text-dim)" : watchHealth(w) === "ok" || watchHealth(w) === "series" ? "var(--sol-text-muted)" : HEALTH_LOOK[watchHealth(w)].ink} label={w.name} /></td>
              <td data-num="" className="mx-col-0" style={since ? { color: "var(--sol-red)" } : undefined}>{since ? durationShort(now - since) : ""}</td>
              <td className="mx-hide-sm mx-col-3"><span className="inline-flex items-center gap-1 ops-dim"><ProviderIcon provider={providerOf.get(w.source_id) ?? "posthog"} />{w.source_name ?? "removed"}</span></td>
              <td data-num="" className="mx-hide-sm mx-col-4 ops-dim">{intervalLabel(w.interval_ms)}</td>
              <td className="mx-hide-sm mx-col-2">{w.group_id && groupById.get(w.group_id) ? <IssueCell group={groupById.get(w.group_id)!} health={watchHealth(w)} /> : issue ? <Link href={opsHref.issue(issue)} className="ops-mono hover:underline">{issue}</Link> : null}</td>
              {tells && <td className="mx-hide-sm mx-col-4 ops-dim mx-tells" data-watch-tells={w.notify ? "" : undefined}>{notifySummary(w.notify, notifyTargets(w.notify, options, channels)) ?? ""}</td>}
              <td data-num="" className="ops-dim">{w.last_at ? relTimeShort(w.last_at, now) : "never"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

/** A watch's issue in the table: its ref and state, and Resolve on an issue still open while the watch is fine. */
function IssueCell({ group, health }: { group: OpsGroup; health: ReturnType<typeof watchHealth> }) {
  const stale = group.status === "open" && (health === "ok" || health === "warn");
  return (
    <span className="mx-issue-cell" onClick={(e) => e.stopPropagation()} data-issue-state={group.status}>
      <Link href={opsHref.issue(group.short_id)} className="ops-mono hover:underline">{group.short_id}</Link>
      <StatusPill status={group.status} />
      {stale && <button type="button" className="mx-link-btn" onClick={() => triage([group], "resolved")} data-issue-resolve={group.short_id}>Resolve</button>}
    </span>
  );
}

/** A failing read on a card: the reader and its error, and Read now. */
function CardError({ watch }: { watch: OpsWatch }) {
  const { asking, readNow } = useReadNow([watch]);
  const h = watchHealth(watch);
  return (
    <div className="mx-card-error" data-health={h} data-watch-error-inline onClick={(e) => e.stopPropagation()}>
      <AlertTriangle aria-hidden />
      <span className="mx-card-error-text" title={watchErrorText(watch) ?? undefined}>{watchErrorText(watch)}</span>
      <button type="button" className="mx-icon-btn" disabled={asking} onClick={readNow} aria-label="Read now" title="Read now" data-watch-read-now>
        {asking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      </button>
    </div>
  );
}

/** How many failing watches a rollup names before the rest fold into a chip that filters the grid to them. */
const ROLLUP_IDS = 12;

/** Several watches on one source failing the same way, as one row: the source, how many, the error, Read all now and the source's health. */
function RollupRow({ rollup: r, source }: { rollup: ErrorRollup; source?: OpsSource }) {
  const { asking, readNow } = useReadNow(r.watches);
  const [fixing, setFixing] = useState(false);
  const kind = r.watches.every((w) => w.query_kind === "reader") ? "readers" : "watches";
  return (
    <div className="mx-rollup" role="listitem" data-error-rollup={r.source_name ?? r.source_id}>
      <AlertTriangle aria-hidden />
      <span className="inline-flex items-center gap-1 font-medium">{source && <ProviderIcon provider={source.provider} />}{r.source_name ?? "removed source"}</span>
      <RollupCount watches={r.watches} kind={kind} />
      <span className="mx-rollup-err" title={r.error}>{r.error}</span>
      <span className="mx-rollup-ids">
        {r.watches.slice(0, ROLLUP_IDS).map((w) => <Link key={w._id} href={opsHref.metric(w.short_id)} className="ops-mono hover:underline">{w.short_id}</Link>)}
        {r.watches.length > ROLLUP_IDS && r.source_name && (
          <Link href={`${opsHref.tab("metrics", { source: r.source_name })}&state=${r.watches.some((w) => watchHealth(w) === "error") ? "error" : "retrying"}`} className="ops-chip" data-rollup-more>+{r.watches.length - ROLLUP_IDS}</Link>
        )}
      </span>
      <span className="flex-1" />
      <button type="button" className="ops-btn" disabled={asking} onClick={readNow} data-rollup-read-now>
        {asking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Read all now
      </button>
      {r.source_name && (source?.provider === "app"
        ? <Link href={opsHref.tab("apps", { source: r.source_name })} className="ops-btn" data-rollup-check>Connector health</Link>
        : <Link href={opsHref.home({ source: r.source_name })} className="ops-btn" data-rollup-check>Check source</Link>)}
      <button type="button" className="ops-btn" data-tone="primary" onClick={() => setFixing(true)} data-rollup-fix><Wand2 className="w-3.5 h-3.5" />Start fix</button>
      {fixing && <ReaderFixReview rollup={r} kind={kind} onClose={() => setFixing(false)} />}
    </div>
  );
}

/** How many of a rollup's watches are erroring and how many retrying (one read missed), each the state chip's count. */
function RollupCount({ watches, kind }: { watches: OpsWatch[]; kind: string }) {
  const erroring = watches.filter((w) => watchHealth(w) === "error").length;
  const once = watches.length - erroring;
  return (
    <b className="ops-num" data-rollup-erroring={erroring} data-rollup-once={once}>
      {erroring > 0 && (erroring === watches.length ? `${erroring} ${kind} erroring` : `${erroring} erroring`)}
      {erroring > 0 && once > 0 && <span className="ops-dim font-normal"> · </span>}
      {once > 0 && <span className={erroring ? "ops-dim font-normal" : undefined}>{erroring ? `${once} retrying` : `${once} ${kind} retrying`}</span>}
    </b>
  );
}

/** Starting a fix for reads that keep failing on one source: it starts an agent session, so it goes through the consequential review. */
function ReaderFixReview({ rollup: r, kind, onClose }: { rollup: ErrorRollup; kind: string; onClose: () => void }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const prompt = readerFixPrompt(r);
  const path = useInboxStore((s) => fixSessionPath(s as never, r.source_id));
  const lines = prompt.split("\n").map((l) => l.trim()).filter(Boolean);
  return (
    <SwitchReview
      ledger={{
        name: "Start a fix session",
        subject: `${r.source_name ?? "removed source"} · ${r.watches.length} ${kind} failing`,
        shift: null,
        figures: [{ value: "1", label: "session starts now" }, { value: String(r.watches.length), label: `${kind} it reads` }],
        rows: [
          { k: "Folder", v: folderName(path) ?? "Where a new session starts", ...(path ? {} : { tone: "warn" as const }) },
          { k: "Watches", v: r.watches.map((w) => w.short_id).join(", ") },
          { k: "Seeded with", v: "The error and the readers", list: showPrompt ? Array.from(new Set(lines)) : undefined, act: { label: showPrompt ? "Hide the prompt" : "Show the prompt", press: () => setShowPrompt((v) => !v) } },
          { k: "Merges", v: MERGES_NEVER, tone: "ok" },
        ],
        stop: "Stop from its session",
        confirm: "Start the session",
        keep: "Not now",
      }}
      onClose={onClose}
      onConfirm={() => {
        onClose();
        spawnSessionWithPrompt({ prompt, projectPath: path, failureLabel: "Failed to start the fix session" });
      }}
    />
  );
}

/** No watches here: a PostHog source gets a starter set; a source that cannot host them says so and names the ones that can; otherwise New watch. */
function MetricsEmpty({ feedEmpty, feedReady, failed, source, hosts, onCreate }: { feedEmpty: ReactNode; feedReady: boolean; failed: boolean; source?: OpsSource; hosts: OpsSource[]; onCreate: (() => void) | null }) {
  if (failed) return <>{feedEmpty}</>;
  if (!feedReady) return <MetricsSkeleton />;
  const posthog = (source ? [source] : hosts).filter((s) => s.provider === "posthog" && s.status === "active");
  if (posthog.length) return <StarterWatches sources={posthog} onCustom={onCreate} />;
  // Errors, logs and CI runs: the series codecast already counts, ready to watch.
  const counted = (source ? [source] : hosts).filter((s) => watchKindsOf(s.provider).includes("volume") && s.status === "active");
  if (counted.length) return <VolumeStarter sources={counted} onCustom={onCreate} />;
  if (source && watchKindsOf(source.provider).length === 0) {
    return (
      <div className="mx-empty-state" data-metrics-empty="no-host">
        <h2>{SOURCE_PROVIDER_LABEL[source.provider]} sources have no metrics</h2>
        {hosts.length > 0 ? (
          <div className="mx-src-list">
            {hosts.map((s) => (
              <Link key={s._id} href={opsHref.tab("metrics", { source: s.name })} className="ops-source-chip"><ProviderIcon provider={s.provider} /><span className="truncate min-w-0">{s.name}</span></Link>
            ))}
          </div>
        ) : (
          <Link href={SETUP_HREF} className="ops-btn">Connect PostHog or an app</Link>
        )}
      </div>
    );
  }
  return (
    <div className="mx-empty-state" data-metrics-empty="none">
      <h2>No watches{source ? ` on ${source.name}` : ""}</h2>
      {onCreate ? (
        <button type="button" className="ops-btn" data-tone="primary" onClick={onCreate} data-metrics-new><Plus className="w-3.5 h-3.5" />New watch</button>
      ) : (
        <Link href={SETUP_HREF} className="ops-btn">Connect PostHog or an app</Link>
      )}
    </div>
  );
}

/** The overview's shape while the watches feed has not answered yet: the filter bar and a grid of cards, so the body never paints empty. */
function MetricsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading metric watches" data-metrics-skeleton>
      <div className="mx-skel-bar" aria-hidden>
        {[64, 64, 58, 70].map((w, i) => <span key={i} className="mx-skel" style={{ width: w, height: 24 }} />)}
        <span className="mx-bar-fill" />
        <span className="mx-skel" style={{ width: 180, height: 26 }} />
        <span className="mx-skel" style={{ width: 150, height: 26 }} />
      </div>
      <div className="mx-grid-cards" aria-hidden>
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="mx-skel-card">
            <span className="mx-skel" style={{ width: `${45 + ((i * 17) % 35)}%`, height: 12 }} />
            <span className="mx-skel" style={{ width: 72, height: 22 }} />
            <span className="mx-skel" />
          </div>
        ))}
      </div>
    </div>
  );
}
