// The Timeline tab: the workspace's event stream, built like a log explorer.
// A query box and facets (source, kind, level, status, each with counts)
// narrow it; a range picker with presets, a jump to a day and a drag on the
// chart set its window; Live keeps the window pinned to now. Over the rows, a
// volume chart (raw occurrences from the groups' hourly buckets, or the
// transitions themselves past their 72 hours) and one swimlane per source
// with deploys drawn across. Rows are one line each and carry what codecast
// did about them (the task it filed, the session fixing it); a row opens its
// event in a side panel without leaving the stream. Filter and range live in
// the URL (`q`, `win`), so a view is a link.
import { entityRoute } from "@codecast/shared/entities";
import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronDown, ExternalLink, Radio, Search, SlidersHorizontal, Workflow, X } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { OPS_SAMPLE_PAGE, useOpsEvents, useOpsGroups, useOpsReplays, useOpsSources, useOpsStreamSamples, useSyncOpsEventPages, useSyncOpsEvents, useSyncOpsSourceOpenGroups, useSyncOpsStreamSamples } from "../../hooks/useSyncOps";
import { GroupFixSlots, TaskChip } from "./OpsHomeRow";
import { useAttentionTasks } from "./useOpsAttention";
import { issueWorkItem } from "./sourceViewModel";
import { ReplayMoment } from "./TimelineOccurrences";
import type { AttentionTask } from "./opsHomeModel";
import { admitsGroup, admitsSample, filterBeyond, fmtStamp, foldRepeats, foldedIds, matchedOnly, nearestReplay, overlayBins, sampleFacetCounts, sampleFacets, splitLevel, streamDayBins, vendorStreamUrl, type RowsView } from "./timelineModel";
import { IssueActs, OccurrencePanel, OccurrenceRows, RowTime } from "./TimelineOccurrences";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { externalEventStyle } from "../../lib/externalEvents";
import { EntityIdPill } from "../EntityIdPill";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isEditableTarget } from "../../shortcuts";
import { eventSourceName, isReleaseMarker } from "./opsModel";
import { opsHref } from "./opsPaths";
import { KIND_LOOK, OpsFeedEmpty, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, useOpsFeed } from "./parts";
import {
  FACETS,
  FACET_LABEL,
  RANGE_PRESETS,
  STACK_INK,
  admits,
  streamAxis,
  STREAM_BUCKET_REACH,
  type StreamMode,
  clusterByPixels,
  clusterSpan,
  dayRange,
  facetCounts,
  fitPreset,
  formatRange,
  formatTimelineQuery,
  fmtTime,
  histogram,
  isEmptyFilter,
  markUnloaded,
  occurrencePoints,
  parseRange,
  parseTimelineQuery,
  rangeTicks,
  tickBudget,
  toggleFacet,
  type Facet,
  type FacetRow,
  type TimeRange,
} from "./timelineModel";
import { VolumeChart, type ChartMark } from "./VolumeChart";
import { useWidth } from "./volumeChartLayout";
import type { OpsEvent, OpsGroup, OpsSample, OpsSource } from "./opsTypes";
import type { HistBin } from "./timelineModel";
import "./sourceView.css";

const HOUR = 3600_000;
/** A window's length as a person reads it: 6h, 72h, 30d. */
const spanText = (ms: number) => (ms >= 48 * HOUR ? `${Math.round(ms / (24 * HOUR))}d` : `${Math.round(ms / HOUR)}h`);
/** Raw occurrences are kept per hour for this long (GROUP_RULES.bucket_hours). */
const BUCKET_REACH = STREAM_BUCKET_REACH;
/** Rows painted before the next screenful is asked for. */
const PAGE_ROWS = 100;
/** A mark's pill is this wide; marks nearer merge. */
const PILL_PX = 22;

const STATUS_WORD: Record<string, string> = {
  new: "new",
  regressed: "regressed",
  spike: "spiked",
  resolved: "resolved",
  check_failed: "check failed",
  check_recovered: "recovered",
  job_failed: "job failed",
  metric_alert: "alerting",
  metric_recovered: "recovered",
  deploy: "deployed",
};
const statusWord = (s: string | null) => (s ? STATUS_WORD[s] ?? externalEventStyle(s).verb ?? s : "");
const statusInk = (s: string | null) => (s && STACK_INK[s]) || "var(--sol-text-muted)";
const kindLabel = (k: string) => (k === "deploy" ? "deploy" : KIND_LOOK[k as keyof typeof KIND_LOOK]?.label ?? k);

const tickLabel = (at: number, span: number) =>
  span > 3 * 86_400_000 ? new Date(at).toLocaleDateString([], { month: "short", day: "numeric" }) : new Date(at).toLocaleTimeString([], { hour: "numeric", minute: span <= 6 * HOUR ? "2-digit" : undefined });

/**
 * The URL's `q`, `win`, `rows` and `event` (the row whose panel is open),
 * read and written in place (router.replace keeps the rest of the address).
 * Opening a panel from none is a history step, so Back closes it and the
 * address shares the event.
 */
function useStreamUrl() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const set = (patch: Record<string, string | null>, opts?: { push?: boolean }) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const s = next.toString();
    const href = s ? `${pathname}?${s}` : pathname ?? "";
    if (opts?.push) router.push(href, { scroll: false });
    else router.replace(href, { scroll: false });
  };
  return { q: params?.get("q") ?? "", win: params?.get("win") ?? null, rows: params?.get("rows") === "transitions" ? ("transitions" as const) : ("occurrences" as const), event: params?.get("event") ?? null, fold: params?.get("fold") !== "0", set };
}

export function TimelineTab({ source }: { source: string | null }) {
  const headFeed = useSyncOpsEvents();
  const sourcesFeed = useOpsFeed("sources");
  const all = useOpsEvents();
  const sources = useOpsSources();
  const groups = useOpsGroups();
  const scoped = sources.find((s) => s.name === source) ?? null;
  const [befores, setBefores] = useState<number[]>([]);
  const pages = useSyncOpsEventPages(scoped?._id ?? null, befores);
  // A scoped stream reads its source's issues: their open rows, vouched for by the source's own answer.
  useSyncOpsSourceOpenGroups(scoped?._id ?? null);
  const { q, win, rows: rowsView, event: open, fold, set } = useStreamUrl();
  const now = useCoarseNow(10_000);
  const occOn = rowsView === "occurrences";
  const [sampleBefores, setSampleBefores] = useState<number[]>([]);
  const samplePages = useSyncOpsStreamSamples(occOn, scoped?._id ?? null, sampleBefores);
  const allSamples = useOpsStreamSamples(scoped?._id ?? null);

  // The scope the shell's source filter sets: the stream is that source's, and the source facet steps aside.
  const inScope = useMemo(() => (source ? all.filter((e) => eventSourceName(e) === source || (scoped && e.source_id === scoped._id)) : all), [all, source, scoped]);
  const fitted = useMemo(() => fitPreset(inScope, now), [inScope, now]);
  const range = parseRange(win, now, fitted);
  const live = range.preset !== null;
  const filter = useMemo(() => parseTimelineQuery(q), [q]);
  const inRange = useMemo(() => inScope.filter((e) => e.created_at >= range.from && e.created_at <= range.to), [inScope, range.from, range.to]);
  const shown = useMemo(() => inRange.filter((e) => admits(e, filter)), [inRange, filter]);
  const counts = useMemo(() => facetCounts(inRange, filter), [inRange, filter]);
  const providerOf = useMemo(() => new Map(sources.map((s) => [s.name, s.provider])), [sources]);
  const sourceIdOf = useMemo(() => new Map(sources.map((s) => [s.name, s._id])), [sources]);
  const groupOf = useMemo(() => new Map(groups.map((g) => [g.short_id, g])), [groups]);
  const groupById = useMemo(() => new Map(groups.map((g) => [g._id, g])), [groups]);
  const sourceById = useMemo(() => new Map(sources.map((s) => [s._id, s])), [sources]);
  const setOpen = (id: string | null) => set({ event: id }, { push: !!id && !open });
  const opened = open && !occOn ? inScope.find((e) => e._id === open) ?? null : null;
  // Occurrences: the samples groups keep, through the same facets (source, kind and level; status is a transition's).
  const facetsOf = useCallback((x: OpsSample) => sampleFacets(x, sourceById, groupById), [sourceById, groupById]);
  const samplesInRange = useMemo(() => (occOn ? allSamples.filter((x) => x.at >= range.from && x.at <= range.to) : []), [occOn, allSamples, range.from, range.to]);
  const samples = useMemo(() => samplesInRange.filter((x) => admitsSample(facetsOf(x), x, filter)), [samplesInRange, filter, facetsOf]);
  const facetRows = useMemo(() => (occOn ? sampleFacetCounts(samplesInRange, facetsOf, filter) : counts), [occOn, samplesInRange, facetsOf, filter, counts]);
  // An event opened from its address may sit outside the filter or the window now: it still opens from what the device holds.
  const openedSample = open && occOn ? samples.find((x) => x._id === open) ?? allSamples.find((x) => x._id === open) ?? null : null;
  // Groups keep a few samples each; the true count of occurrences comes from their hourly buckets, which reach back BUCKET_REACH.
  const occTotal = useMemo(() => {
    if (!occOn || range.from < now - BUCKET_REACH) return null;
    const ids = source ? new Set(scoped ? [scoped._id] : []) : facetSourceIds(filter.facets.source, sourceIdOf);
    // Metric readings are left out of the rows by default, so out of the count they are measured against too.
    const gs = groups.filter((g) => (!ids || ids.has(g.source_id)) && admitsGroup(g, filter) && (filter.facets.kind.size > 0 || g.kind !== "metric"));
    return occurrencePoints(gs).reduce((n, p) => (p.at >= range.from && p.at <= range.to + HOUR ? n + p.n : n), 0);
  }, [occOn, range.from, range.to, now, source, scoped, filter, sourceIdOf, groups]);
  // Every event the sources counted in the window, past the buckets' reach: their day counters, when the filter is only a source.
  const counterTotal = useMemo(() => {
    if (!occOn || occTotal !== null || filterBeyond(filter, "counter")) return null;
    const ids = source ? new Set(scoped ? [scoped._id] : []) : facetSourceIds(filter.facets.source, sourceIdOf);
    // The same bins the chart draws, estimates included, so "kept of N" and the chart's total are one number.
    return streamDayBins(sources, groups, ids, filter, range, samples).reduce((n, b) => (b.to > range.from ? n + b.total : n), 0) || null;
  }, [occOn, occTotal, filter, source, scoped, sourceIdOf, sources, groups, samples, range]);
  // The rest of the window at the vendor, for the one source in view, when codecast keeps only samples of it.
  const vendorSource = scoped ?? (filter.facets.source.size === 1 ? sources.find((s) => filter.facets.source.has(s.name)) ?? null : null);
  const vendor = occOn && vendorSource ? vendorStreamUrl(vendorSource, range, filter) : null;
  // The tasks behind the rows' issues, for the Codecast column's chips (id, state, assignee).
  const rowGroups = useMemo(() => (occOn ? [] : shown.slice(0, 400).flatMap((e) => (e.data?.group_short_id && groupOf.get(e.data.group_short_id)) || [])), [occOn, shown, groupOf]);
  const taskOf = useAttentionTasks(rowGroups);
  // Consecutive occurrences of one issue fold into one line (on unless the address says fold=0); a run holding the open row stays open.
  const folded = useMemo(() => (occOn ? (fold ? foldRepeats(samples) : samples.map((x) => ({ kind: "one" as const, sample: x }))) : []), [occOn, fold, samples]);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<string>>(() => new Set());
  const runOfOpen = open ? folded.flatMap((it) => (it.kind === "run" && it.samples.some((x) => x._id === open) ? [it.key] : []))[0] ?? null : null;
  const expanded = useMemo(() => (runOfOpen && !expandedRuns.has(runOfOpen) ? new Set([...expandedRuns, runOfOpen]) : expandedRuns), [expandedRuns, runOfOpen]);
  const toggleRun = (key: string) => setExpandedRuns((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  const runs = folded.filter((it) => it.kind === "run").length;
  const rowIds = occOn ? foldedIds(folded, expanded) : shown.map((e) => e._id);
  const [cursor, setCursor] = useState<string | null>(null);
  // What the chart's bars count; the lanes under it draw on the chart's own span (streamAxis), so a date is one line through both.
  const [streamMode, setStreamMode] = useState<StreamMode>("volume");
  const laneAxisAt = streamAxis(range, streamMode);
  const laneAxis = useMemo(() => ({ ...range, from: laneAxisAt.from, to: laneAxisAt.to }), [range, laneAxisAt.from, laneAxisAt.to]);
  useListKeys(rowIds, cursor, setCursor, open, setOpen);

  // A lane's count is its source's row in the Source facet, so the two read one number in either list view.
  const laneCounts = useMemo(() => (source && scoped ? new Map([[source, occOn ? samples.length : shown.length]]) : new Map((facetRows.source as FacetRow[]).filter((r) => !r.none && !r.off).map((r) => [r.value, r.n]))), [source, scoped, occOn, samples.length, shown.length, facetRows]);
  const setRange = (r: Pick<TimeRange, "from" | "to" | "preset">) => set({ win: formatRange(r) });
  const setQuery = (next: string) => set({ q: next || null });

  // Older pages: when the oldest row held is inside the range and more may sit past it, ask for the page before it.
  const oldest = inScope.length ? inScope[inScope.length - 1].created_at : null;
  const lastPage = pages.pages.filter((p, i) => befores[i] != null).at(-1);
  const exhausted = befores.length > 0 && lastPage?.ready && oldest != null && oldest >= befores[befores.length - 1];
  const canOlder = oldest != null && befores.length < 5 && !exhausted && !befores.includes(oldest) && headFeed.ready;
  const loadOlder = () => {
    if (canOlder) setBefores((b) => [...b, oldest!]);
  };
  // A range wider than the rows held pages older rows in, up to the page cap, so the list reaches as far as the range asks.
  useWatchEffect(() => {
    if (!occOn && canOlder && oldest != null && range.from < oldest) setBefores((b) => (b.includes(oldest) ? b : [...b, oldest]));
  }, [occOn, canOlder, oldest, range.from]);
  const oldestSample = allSamples.length ? allSamples[allSamples.length - 1].at : null;
  const lastSamplePage = samplePages[sampleBefores.length];
  // The newest page asked for came back short: nothing older is kept.
  const lastBefore = sampleBefores.at(-1) ?? Infinity;
  const samplesExhausted = !!lastSamplePage?.ready && allSamples.filter((x) => x.at < lastBefore).length < OPS_SAMPLE_PAGE;
  const canOlderSamples = occOn && oldestSample != null && sampleBefores.length < 4 && !samplesExhausted && !sampleBefores.includes(oldestSample);
  const setRows = (v: RowsView) => {
    // The stream opens on what happened (occurrences, the rows the chart counts); transitions are the one to ask for.
    set({ rows: v === "transitions" ? v : null, event: null });
  };

  if (!sources.length && !all.length) {
    return (
      <OpsFeedEmpty feeds={[sourcesFeed, headFeed]} what="the timeline" title="No sources yet">
        <Link href={SETUP_HREF} className="ops-btn" data-tone="primary">Connect a source</Link>
      </OpsFeedEmpty>
    );
  }

  // A name that matches no source (an old link, a typo) says so and lists the real ones, rather than reading as silence.
  if (source && !scoped && sourcesFeed?.ready && sources.length && !inScope.length) {
    return (
      <div className="otl-empty" data-ops-unknown-source>
        <b>No source named {source}</b>
        <span className="otl-empty-acts otl-source-list">
          {sources.map((s) => (
            <Link key={s._id} href={opsHref.tab("timeline", { source: s.name })} className="ops-btn"><ProviderIcon provider={s.provider} />{s.name}</Link>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className="otl" data-ops-timeline data-open={opened || openedSample ? "true" : undefined}>
      <TimelineBar q={q} setQuery={setQuery} range={range} live={live} setRange={setRange} fitted={fitted} now={now} count={occOn ? samples.length : shown.length} total={occOn ? samples.length : inRange.length} kept={occOn ? { total: occTotal } : null} />
      <div className="otl-body">
        <Facets counts={facetRows} filter={filter} q={q} setQuery={setQuery} hide={source ? ["source"] : []} providerOf={providerOf} unit={occOn ? "Kept rows" : "Transitions"} />
        <div className="otl-main">
          <StreamChart mode={streamMode} setMode={setStreamMode} events={shown} rows={occOn ? samples.map((x) => ({ at: x.at, key: sampleKey(facetsOf(x)) })) : null} groups={groups} sources={sources} sourceIds={source ? new Set(scoped ? [scoped._id] : []) : facetSourceIds(filter.facets.source, sourceIdOf)} filter={filter} range={range} setRange={setRange} oldestLoaded={oldest} moreOlder={!exhausted} />
          <Lanes events={shown} range={laneAxis} providerOf={providerOf} q={q} setQuery={setQuery} setRange={setRange} scoped={!!source} counts={laneCounts} unit={occOn ? "Kept rows" : "Transitions"} />
          <div className="otl-rows-bar">
            <div className="ops-seg" role="group" aria-label="Rows">
              <button type="button" data-on={occOn ? "true" : undefined} aria-pressed={occOn} onClick={() => setRows("occurrences")} title="Each kept occurrence with its message, stack, url, user and release">Occurrences</button>
              <button type="button" data-on={!occOn ? "true" : undefined} aria-pressed={!occOn} onClick={() => setRows("transitions")} title="What changed: new, regressed, spiked, resolved, alerting">Transitions{shown.length ? <span className="ops-num ops-dim"> {shown.length.toLocaleString()}</span> : null}</button>
            </div>
            {occOn && (runs > 0 || !fold) && (
              <button type="button" className="otl-fold" data-on={fold ? "true" : undefined} aria-pressed={fold} onClick={() => set({ fold: fold ? "0" : null })} title="Fold consecutive occurrences of the same issue into one line" data-ops-fold>
                Fold repeats{fold && runs ? <span className="ops-num ops-dim"> {runs.toLocaleString()}</span> : null}
              </button>
            )}
            {/* The gap between the rows kept and everything counted, and the vendor's full list, at the head of the list. */}
            {occOn && (
              <span className="otl-rows-gap ops-dim" data-ops-rows-gap>
                {(occTotal ?? counterTotal) !== null && (occTotal ?? counterTotal)! > samples.length && <span className="ops-num">{samples.length.toLocaleString()} kept of {(occTotal ?? counterTotal)!.toLocaleString()}</span>}
                {vendor && vendorSource && <a href={vendor} target="_blank" rel="noreferrer" className="ops-link inline-flex items-center gap-1" data-ops-vendor-head>Show all in {SOURCE_PROVIDER_LABEL[vendorSource.provider] ?? vendorSource.provider}<ExternalLink className="w-3 h-3" /></a>}
              </span>
            )}
            <span className="flex-1" />
            <span className="otl-keys ops-dim" aria-label="Keys: j and k move, Enter opens"><KeyCap size="xs">j</KeyCap><KeyCap size="xs">k</KeyCap><KeyCap size="xs">↵</KeyCap></span>
          </div>
          {occOn ? (
            <OccurrenceRows
              samples={samples}
              items={folded}
              expanded={expanded}
              toggleRun={toggleRun}
              span={range.to - range.from}
              groupById={groupById}
              sourceById={sourceById}
              open={open}
              cursor={cursor}
              setOpen={setOpen}
              loading={!samplePages[0]?.ready && !allSamples.length}
              canOlder={canOlderSamples}
              loadingOlder={sampleBefores.length > 0 && !lastSamplePage?.ready}
              loadOlder={() => { if (canOlderSamples) setSampleBefores((b) => [...b, oldestSample!]); }}
              filtered={!isEmptyFilter(filter)}
              clear={() => setQuery("")}
              source={source}
              gap={{ total: occTotal ?? counterTotal, vendor: vendor && vendorSource ? { url: vendor, name: SOURCE_PROVIDER_LABEL[vendorSource.provider] ?? vendorSource.provider } : null }}
              transitions={shown.length ? { n: shown.length, show: () => setRows("transitions") } : null}
            />
          ) : (
          <Rows
            events={shown}
            span={range.to - range.from}
            groupOf={groupOf}
            providerOf={providerOf}
            open={open}
            cursor={cursor}
            setOpen={setOpen}
            live={live}
            canOlder={canOlder}
            loadingOlder={befores.length > 0 && !lastPage?.ready}
            loadOlder={loadOlder}
            reachedStart={!!exhausted}
            filtered={!isEmptyFilter(filter)}
            clear={() => setQuery("")}
            widen={() => setRange({ ...parseRange("30d", now), preset: "30d" })}
            source={source}
            taskOf={taskOf}
          />
          )}
        </div>
        {openedSample && <OccurrencePanel sample={openedSample} group={groupById.get(openedSample.group_id)} source={sourceById.get(openedSample.source_id)} onClose={() => setOpen(null)} />}
        {opened && <EventPanel event={opened} group={opened.data?.group_short_id ? groupOf.get(opened.data.group_short_id) : undefined} provider={providerOf.get(eventSourceName(opened))} taskOf={taskOf} onClose={() => setOpen(null)} />}
      </div>
    </div>
  );
}

/** How an occurrence stacks in the chart: its level, else its type, else its issue's kind. */
const sampleKey = (v: Record<string, string | null>) => v.level ?? v.type ?? v.kind ?? "event";

function facetSourceIds(names: Set<string>, idOf: Map<string, string>): Set<string> | null {
  if (!names.size) return null;
  return new Set([...names].map((n) => idOf.get(n)).filter((x): x is string => !!x));
}

// ── The bar: query, live, range ──

function TimelineBar({ q, setQuery, range, live, setRange, fitted, now, count, total, kept }: { q: string; setQuery: (q: string) => void; range: TimeRange; live: boolean; setRange: (r: Pick<TimeRange, "from" | "to" | "preset">) => void; fitted: string; now: number; count: number; total: number; /** Occurrences: the rows are kept samples; `total` is every occurrence in the window when the buckets reach it. */ kept: { total: number | null } | null }) {
  const [draft, setDraft] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  useWatchEffect(() => setDraft(q), [q]);
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || isEditableTarget(e.target)) return;
      // The shell's `/` opens the source filter when there is one; inside the stream, `/` is the query box.
      e.preventDefault();
      e.stopImmediatePropagation();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const span = range.to - range.from;
  const dayValue = new Date(range.from - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return (
    <div className="otl-bar">
      <form className="otl-query" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); }}>
        <Search className="w-3.5 h-3.5 ops-dim" aria-hidden />
        <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft.trim() !== q && setQuery(draft.trim())} placeholder="Search, or source:web kind:error level:fatal status:regressed" aria-label="Filter the stream" spellCheck={false} />
        {draft ? (
          <button type="button" className="otl-clear" aria-label="Clear the filter" onClick={() => { setDraft(""); setQuery(""); }}><X className="w-3.5 h-3.5" /></button>
        ) : (
          <span className="otl-key"><KeyCap size="xs">/</KeyCap></span>
        )}
      </form>
      {kept ? (
        <span className="otl-count ops-num ops-dim" data-ops-kept title="Each issue keeps its newest samples; the total counts every occurrence in this window">
          {count.toLocaleString()} kept{kept.total != null && kept.total > count ? ` of ${kept.total.toLocaleString()}` : ""}
        </span>
      ) : (
        <span className="otl-count ops-num ops-dim">{count.toLocaleString()}{count !== total ? ` of ${total.toLocaleString()}` : ""}</span>
      )}
      <button
        type="button"
        className="otl-live"
        data-on={live ? "true" : undefined}
        aria-pressed={live}
        title={live ? "Pinned to now; press to hold this window" : "Pin the window to now"}
        onClick={() => (live ? setRange({ from: range.from, to: now, preset: null }) : setRange({ ...parseRange(fitted, now), preset: fitted as TimeRange["preset"] }))}
      >
        <Radio className="w-3.5 h-3.5" />
        {live ? "Live" : "Held"}
      </button>
      <div className="ops-seg otl-presets" role="group" aria-label="Range">
        {RANGE_PRESETS.map((p) => (
          <button key={p.key} type="button" data-on={range.preset === p.key ? "true" : undefined} aria-pressed={range.preset === p.key} onClick={() => setRange({ from: now - p.ms, to: now, preset: p.key })}>
            {p.key}
          </button>
        ))}
      </div>
      {!range.preset && (
        <span className="otl-span ops-num" data-ops-span>
          {fmtTime(range.from, span)} to {fmtTime(range.to, span)}
          <button type="button" aria-label="Back to the live window" onClick={() => setRange({ ...parseRange(fitted, now), preset: fitted as TimeRange["preset"] })}><X className="w-3 h-3" /></button>
        </span>
      )}
      <label className="otl-jump" title="Jump to a day">
        <CalendarDays className="w-3.5 h-3.5" />
        <input
          type="date"
          aria-label="Jump to a day"
          max={new Date(now - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)}
          value={range.preset ? "" : dayValue}
          onChange={(e) => {
            const r = dayRange(e.target.value, now);
            if (r) setRange(r);
          }}
        />
      </label>
      {/* The flows app's timeline is the other stream: what agents and runs did. This one is what the product sent. */}
      <Link href="/flows?view=timeline" className="otl-jump otl-xlink" title="Flow timeline: conversations, runs, decisions and deploys" aria-label="Flow timeline"><Workflow className="w-3.5 h-3.5" /></Link>
    </div>
  );
}

// ── Facets ──

const FACET_SHOWN = 6;

function Facets({ counts, filter, q, setQuery, hide, providerOf, unit }: { counts: Record<Facet, FacetRow[]>; filter: ReturnType<typeof parseTimelineQuery>; q: string; setQuery: (q: string) => void; hide: Facet[]; providerOf: Map<string, OpsSource["provider"]>; /** What the counts count: kept rows or transitions. */ unit: string }) {
  const [more, setMore] = useState<Set<Facet>>(new Set());
  // Narrow windows fold the facets behind one button (CSS shows it under 1100px); wide ones always show them.
  const [folded, setFolded] = useState(true);
  const picked = FACETS.reduce((n, f) => n + filter.facets[f].size, 0);
  return (
    <>
    <button type="button" className="ops-btn otl-filters-btn" aria-expanded={!folded} onClick={() => setFolded((f) => !f)}>
      <SlidersHorizontal className="w-3.5 h-3.5" />Filters{picked ? <span className="ops-num"> {picked}</span> : null}<ChevronDown className="w-3 h-3" style={{ transform: folded ? undefined : "rotate(180deg)" }} />
    </button>
    <aside className="otl-facets" aria-label="Facets" data-folded={folded ? "true" : undefined}>
      <div className="otl-facets-unit ops-dim" data-ops-facet-unit>{unit}</div>
      {FACETS.filter((f) => !hide.includes(f)).map((facet) => {
        const rows = counts[facet];
        if (!rows.length) return null;
        const all = more.has(facet);
        const list = all ? rows : rows.slice(0, FACET_SHOWN);
        return (
          <section key={facet} className="otl-facet" data-facet={facet}>
            <div className="otl-facet-head">
              {FACET_LABEL[facet]}
              {filter.facets[facet].size > 0 && (
                <button type="button" className="ops-dim" onClick={() => setQuery(clearFacet(q, facet))}>clear</button>
              )}
            </div>
            {list.map(({ value, n, off, none }) => {
              // The rows with no value here: counted so the group adds up to the rows kept, not a value to pick.
              if (none) return (
                <div key="(none)" className="otl-facet-row" data-none="true" data-ops-facet-none>
                  <span className="otl-facet-pick"><span className="otl-check" aria-hidden /><span className="truncate ops-dim">no {FACET_LABEL[facet].toLowerCase()}</span><span className="otl-facet-n ops-num">{n.toLocaleString()}</span></span>
                </div>
              );
              const on = filter.facets[facet].has(value);
              return (
                <div key={value} className="otl-facet-row" data-on={on ? "true" : undefined} data-off={off ? "true" : undefined} title={off ? `${n.toLocaleString()} left out until picked` : undefined}>
                  <button type="button" className="otl-facet-pick" aria-pressed={on} onClick={() => setQuery(toggleFacet(q, facet, value))}>
                    <span className="otl-check" aria-hidden />
                    {facet === "source" && providerOf.get(value) ? <ProviderIcon provider={providerOf.get(value)!} /> : null}
                    {facet === "status" || facet === "level" || facet === "kind" ? <i className="otl-swatch" style={{ background: statusInk(value) }} /> : null}
                    <span className="truncate">{facet === "status" ? statusWord(value) : facet === "kind" ? kindLabel(value) : value}</span>
                    {/* A value left out until picked counts nothing kept: it says off, its count on hover. */}
                    <span className="otl-facet-n ops-num">{off ? "off" : n.toLocaleString()}</span>
                  </button>
                  <button type="button" className="otl-only" title={`Only ${value}`} onClick={() => setQuery(toggleFacet(q, facet, value, true))}>only</button>
                </div>
              );
            })}
            {rows.length > FACET_SHOWN && (
              <button type="button" className="otl-more" onClick={() => setMore((m) => { const n = new Set(m); if (!n.delete(facet)) n.add(facet); return n; })}>
                {all ? "fewer" : `${rows.length - FACET_SHOWN} more`}
              </button>
            )}
          </section>
        );
      })}
    </aside>
    </>
  );
}

function clearFacet(q: string, facet: Facet): string {
  const f = parseTimelineQuery(q);
  f.facets[facet].clear();
  return formatTimelineQuery(f);
}

// ── The chart ──

function StreamChart({ events, rows, groups, sources, sourceIds, filter, range, setRange, oldestLoaded, moreOlder, mode, setMode }: { mode: StreamMode; setMode: (m: StreamMode) => void; events: OpsEvent[]; /** Occurrences: the kept samples the list shows; null for transitions (the events). */ rows: { at: number; key: string }[] | null; groups: OpsGroup[]; sources: OpsSource[]; sourceIds: Set<string> | null; filter: ReturnType<typeof parseTimelineQuery>; range: TimeRange; setRange: (r: TimeRange) => void; oldestLoaded: number | null; moreOlder: boolean }) {
  const span = range.to - range.from;
  // Volume reads the server's own series: hourly occurrences inside the buckets' 72 hours, the sources' day counters past them.
  // Under six hours an hourly bucket would draw as one block, so the bars count transitions there.
  const volumeOk = span >= 6 * HOUR;
  // The bins and the span they cover come from streamAxis, which the lanes below draw on too.
  const axis = streamAxis(range, mode);
  const { daily, width } = axis;
  const useVolume = axis.volume;
  const axisRange = useMemo(() => ({ from: axis.from, to: axis.to }), [axis.from, axis.to]);
  // The rows the list shows, as points: what a filter the server series cannot split by is drawn from.
  const listed = useMemo(() => rows ?? events.filter((e) => !isReleaseMarker(e)).map((e) => ({ at: e.created_at, key: e.data?.transition ?? e.kind })), [rows, events]);
  const { bins, chartRange, what, matched } = useMemo(() => {
    if (!useVolume) {
      const b = histogram(listed, (p) => p.at, (p) => p.key, () => 1, range, width);
      return { bins: rows ? b : markUnloaded(b, oldestLoaded, moreOlder), chartRange: axisRange, what: rows ? "Kept occurrences" : "Transitions", matched: null };
    }
    let b: HistBin[];
    let label: string;
    let beyond: boolean;
    if (daily) {
      // Days the counter has no record of are drawn from what the stream keeps (its rows, the issues' hourly buckets), marked estimated, so the bars never contradict the lanes under them.
      b = streamDayBins(sources, groups, sourceIds, filter, range, listed);
      label = "Events per day";
      beyond = filterBeyond(filter, "counter");
    } else {
      const gs = groups.filter((g) => (!sourceIds || sourceIds.has(g.source_id)) && admitsGroup(g, filter));
      b = histogram(occurrencePoints(gs), (p) => p.at, (p) => p.key, (p) => p.n, range, width);
      label = "Occurrences per hour";
      beyond = filterBeyond(filter, "groups");
    }
    const chartRange = axisRange;
    // The series cannot split by this filter: the matching rows go on top of a faint total, so the header and the bars move with the query.
    if (!beyond) return { bins: b, chartRange, what: label, matched: null };
    const over = overlayBins(b, listed);
    return { bins: over.bins, chartRange, what: label, matched: over.matched };
  }, [useVolume, daily, listed, rows, groups, sources, sourceIds, filter, range, width, axisRange, oldestLoaded, moreOlder]);
  // A filter the series cannot split by: the bars rescale to what matches, with everything counted one press away.
  const [showAll, setShowAll] = useState(false);
  const drawn = useMemo(() => (matched !== null && !showAll ? matchedOnly(bins) : bins), [bins, matched, showAll]);
  const total = bins.reduce((n, b) => n + b.total, 0);
  const marks: ChartMark[] = events.filter(isReleaseMarker).map((e) => ({
    at: e.created_at,
    label: e.meta?.deploy ?? e.data?.release ?? "deploy",
    href: e.meta?.deploy ? entityRoute("deploy", e.meta.deploy) ?? undefined : undefined,
  }));
  return (
    <section className="otl-chart" aria-label="Volume">
      <div className="otl-chart-head">
        <div className="ops-seg" role="group" aria-label="What the bars count">
          <button type="button" data-on={useVolume ? "true" : undefined} aria-pressed={useVolume} disabled={!volumeOk} title={volumeOk ? (daily ? "Events per day, from each source's counter" : "Occurrences per hour, by level") : "Volume is counted per hour; pick 6h or wider"} onClick={() => setMode("volume")}>Volume</button>
          <button type="button" data-on={!useVolume ? "true" : undefined} aria-pressed={!useVolume} onClick={() => setMode("transitions")}>Transitions</button>
        </div>
        <span className="text-[11px] ops-dim">{what}</span>
        {/* The total names its window, so a per-day label never reads as a day's count; per day also shows the average. */}
        <span className="ops-num text-[11px]" data-ops-chart-total title={matched !== null ? "Rows matching the filter, of everything the sources counted" : undefined}>{matched !== null ? `${matched.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()} <span className="ops-dim">in {spanText(range.to - range.from)}</span></span>
        {useVolume && daily && bins.length > 1 && matched === null && <span className="ops-num text-[11px] ops-dim" data-ops-chart-avg>avg {Math.round(total / bins.length).toLocaleString()}/day</span>}
        {matched !== null && (
          <div className="ops-seg" role="group" aria-label="Bars show">
            <button type="button" data-on={!showAll ? "true" : undefined} aria-pressed={!showAll} onClick={() => setShowAll(false)} data-ops-chart-matching>Matching</button>
            <button type="button" data-on={showAll ? "true" : undefined} aria-pressed={showAll} onClick={() => setShowAll(true)} data-ops-chart-all>All</button>
          </div>
        )}
        <span className="flex-1" />
        <span className="ops-dim text-[11px] otl-hint">drag to zoom</span>
      </div>
      <VolumeChart bins={drawn} range={chartRange} marks={marks} onBrush={(from, to) => setRange({ from, to, preset: null })} height={84} label="stream" />
    </section>
  );
}

// ── Lanes ──

function Lanes({ events, range, providerOf, q, setQuery, setRange, scoped, counts, unit }: { events: OpsEvent[]; range: TimeRange; providerOf: Map<string, OpsSource["provider"]>; q: string; setQuery: (q: string) => void; setRange: (r: TimeRange) => void; scoped: boolean; /** Each lane's count, in the list's unit: the Source facet's own numbers. */ counts: Map<string, number>; unit: string }) {
  // The axis spans exactly the tracks, so its width is the room the marks cluster in.
  const [ref, trackW] = useWidth<HTMLDivElement>();
  const span = Math.max(1, range.to - range.from);
  const xOf = (t: number) => Math.min(1, Math.max(0, (t - range.from) / span));
  const lanes = useMemo(() => {
    const m = new Map<string, { event: OpsEvent; x: number }[]>();
    for (const e of events) {
      if (isReleaseMarker(e)) continue;
      const name = eventSourceName(e);
      if (!m.has(name)) m.set(name, []);
      m.get(name)!.push({ event: e, x: xOf(e.created_at) });
    }
    return [...m];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- xOf reads the range
  }, [events, range.from, range.to]);
  const ticks = rangeTicks(range, tickBudget(trackW));
  if (!lanes.length) return null;
  return (
    // One source in scope keeps its name column too: the chart's plot starts after the same gutter, so a date is one line through both.
    <section className="ops-tl otl-lanes" aria-label="Transitions by source">
      <div className="ops-tl-axis" ref={ref}>
        <span className="otl-lanes-unit" data-ops-lanes-unit>{unit}</span>
        {ticks.map((t) => <span key={t.at} className="ops-tl-tick ops-num" style={{ left: `${t.x * 100}%` }}>{tickLabel(t.at, span)}</span>)}
      </div>
      {lanes.map(([name, marks]) => (
        <div key={name} className="ops-tl-lane">
          {scoped ? (
            <div className="ops-tl-name" title={name}>{providerOf.get(name) && <ProviderIcon provider={providerOf.get(name)!} />}<span className="truncate">{name}</span><span className="ops-dim ops-num ml-auto" title={`${unit} in range`}>{(counts.get(name) ?? 0).toLocaleString()}</span></div>
          ) : (
            <button type="button" className="ops-tl-name otl-lane-name" title={`Only ${name}`} onClick={() => setQuery(toggleFacet(q, "source", name, true))}>
              {providerOf.get(name) && <ProviderIcon provider={providerOf.get(name)!} />}
              <span className="truncate">{name}</span>
              <span className="ops-dim ops-num ml-auto" title={`${unit} in range`}>{(counts.get(name) ?? 0).toLocaleString()}</span>
            </button>
          )}
          <div className="ops-tl-track">
            {clusterByPixels(marks, trackW, PILL_PX).map((c) => <Cluster key={c.marks[0].event._id} cluster={c} span={span} pin={trackW > 0 && c.x * trackW < PILL_PX / 2 ? "start" : trackW > 0 && (1 - c.x) * trackW < PILL_PX / 2 ? "end" : undefined} onZoom={() => setRange({ ...clusterSpan(c.marks), preset: null })} />)}
          </div>
        </div>
      ))}
    </section>
  );
}

const POP_ROWS = 12;

/** pin: a mark within half a pill of the track's edge sits inside it rather than centred on the edge, where the frame would cut it in half. */
function Cluster({ cluster, span, pin, onZoom }: { cluster: { x: number; marks: { event: OpsEvent; x: number }[] }; span: number; pin?: "start" | "end"; onZoom: () => void }) {
  const [pop, setPop] = useState(false);
  const marks = [...cluster.marks].sort((a, b) => b.event.created_at - a.event.created_at);
  const lead = marks.find((m) => statusInk(m.event.data?.transition ?? m.event.kind) === STACK_INK.new) ?? marks[0];
  const many = marks.length > 1;
  const ink = statusInk(lead.event.data?.transition ?? lead.event.kind);
  const single = !many && lead.event.data?.group_short_id ? opsHref.issue(lead.event.data.group_short_id) : null;
  const body = many ? <span className="ops-num">{marks.length}</span> : null;
  return (
    <span className="otl-cluster-wrap" style={{ left: `${cluster.x * 100}%` }} onMouseEnter={() => setPop(true)} onMouseLeave={() => setPop(false)} onFocus={() => setPop(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPop(false); }} data-edge={cluster.x > 0.7 ? "end" : undefined} data-pin={pin}>
      {single ? (
        <Link href={single} className="ops-tl-mark otl-mark" style={{ background: ink }} aria-label={lead.event.title} />
      ) : (
        <button type="button" className={many ? "ops-tl-cluster otl-mark" : "ops-tl-mark otl-mark"} style={{ background: ink }} onClick={onZoom} aria-label={`${marks.length} transitions: zoom to them`}>{body}</button>
      )}
      {pop && (
        <span className="otl-pop" role="dialog" aria-label={`${marks.length} transitions`}>
          {marks.slice(0, POP_ROWS).map((m) => {
            const id = m.event.data?.group_short_id;
            const st = m.event.data?.transition ?? m.event.kind;
            const row = (
              <>
                <i style={{ background: statusInk(st) }} />
                <span className="otl-pop-st">{statusWord(st)}</span>
                <span className="truncate">{m.event.title}</span>
                <span className="ops-dim ops-num">{fmtTime(m.event.created_at, span)}</span>
              </>
            );
            return id ? <Link key={m.event._id} href={opsHref.issue(id)} className="otl-pop-row">{row}</Link> : <span key={m.event._id} className="otl-pop-row">{row}</span>;
          })}
          {marks.length > POP_ROWS && <span className="otl-pop-more ops-dim">{marks.length - POP_ROWS} more</span>}
          {many && <button type="button" className="otl-pop-zoom" onClick={onZoom}>Zoom to these</button>}
        </span>
      )}
    </span>
  );
}

// ── Rows ──

function Rows(p: {
  events: OpsEvent[];
  span: number;
  groupOf: Map<string, OpsGroup>;
  providerOf: Map<string, OpsSource["provider"]>;
  open: string | null;
  cursor: string | null;
  setOpen: (id: string | null) => void;
  live: boolean;
  canOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  reachedStart: boolean;
  filtered: boolean;
  clear: () => void;
  widen: () => void;
  source: string | null;
  taskOf: (id: string) => AttentionTask | undefined;
}) {
  const [limit, setLimit] = useState(PAGE_ROWS);
  const rowNow = useCoarseNow(60_000);
  const list = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // "N new": rows that arrived while the reader was scrolled away from the top.
  const [anchor, setAnchor] = useState<number | null>(null);
  const newest = p.events[0]?.created_at ?? 0;
  const fresh = anchor != null ? p.events.filter((e) => e.created_at > anchor).length : 0;
  useWatchEffect(() => {
    const scroller = list.current?.closest(".ops-body") as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => setAnchor((a) => (scroller.scrollTop > 240 ? a ?? newest : null));
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [newest]);
  // More rows as the end comes into view: the next screenful, then the server's next page.
  useWatchEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      if (limit < p.events.length) setLimit((l) => l + PAGE_ROWS);
      else if (p.canOlder) p.loadOlder();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, p.events.length, p.canOlder]);

  if (!p.events.length) {
    return (
      <div className="otl-empty" data-ops-stream-empty>
        <b>{p.filtered ? "Nothing matches" : p.source ? `Nothing from ${p.source} in this window` : "Nothing in this window"}</b>
        <span className="otl-empty-acts">
          {p.filtered && <button type="button" className="ops-btn" onClick={p.clear}>Clear the filter</button>}
          <button type="button" className="ops-btn" onClick={p.widen}>Last 30 days</button>
          {p.canOlder && <button type="button" className="ops-btn" onClick={p.loadOlder}>Load older</button>}
        </span>
      </div>
    );
  }
  return (
    <section className="otl-rows" ref={list} aria-label="Events" data-span={p.span > 2 * 86_400_000 ? "long" : undefined}>
      {fresh > 0 && (
        <button type="button" className="otl-fresh" onClick={() => { (list.current?.closest(".ops-body") as HTMLElement | null)?.scrollTo({ top: 0, behavior: "smooth" }); setAnchor(null); }}>
          {fresh} new
        </button>
      )}
      <div className="otl-row otl-row-head" aria-hidden>
        <span>Time</span><span>Source</span><span>What</span><span>Title</span><span>Issue</span><span>Codecast</span>
      </div>
      {p.events.slice(0, limit).map((e) => (
        <Row key={e._id} e={e} span={p.span} now={rowNow} group={e.data?.group_short_id ? p.groupOf.get(e.data.group_short_id) : undefined} taskOf={p.taskOf} provider={p.providerOf.get(eventSourceName(e))} on={p.open === e._id} cursor={p.cursor === e._id} onOpen={() => p.setOpen(p.open === e._id ? null : e._id)} />
      ))}
      <div ref={sentinel} className="otl-sentinel">
        {limit < p.events.length ? (
          <button type="button" className="ops-btn" onClick={() => setLimit((l) => l + PAGE_ROWS)}>Show {Math.min(PAGE_ROWS, p.events.length - limit)} more</button>
        ) : p.loadingOlder ? (
          <span className="ops-dim">Reading older events…</span>
        ) : p.canOlder ? (
          <button type="button" className="ops-btn" onClick={p.loadOlder}>Load older</button>
        ) : (
          <span className="ops-dim">{p.reachedStart ? "The start of this source's stream" : `${p.events.length.toLocaleString()} events`}</span>
        )}
      </div>
    </section>
  );
}

/**
 * What codecast did about it: the task it filed (its ct- id, state and who
 * has it), a live dot for the session fixing it, the deploy that carried it;
 * on an open issue nobody is on, Fix.
 */
function Outcome({ e, group, task }: { e: OpsEvent; group?: OpsGroup; task?: AttentionTask }) {
  const out: ReactNode[] = [];
  if (e.meta?.deploy) out.push(<EntityIdPill key="dp" shortId={e.meta.deploy} type="deploy" compact />);
  if (group?.signal_task_id) out.push(<TaskChip key="task" taskId={group.signal_task_id} task={task ?? null} />);
  // An open issue's fix session is its fix plan's press below (open, continue); a settled one keeps the link to the session that fixed it.
  if (group?.fix_conversation_id && group.status !== "open") out.push(<Link key="fix" href={`/conversation/${group.fix_conversation_id}`} className="otl-live-fix" title="The session that fixed it" data-ops-fixing><i aria-hidden />fixed</Link>);
  if (!out.length && group?.status === "resolved") out.push(<span key="res" className="otl-pill" data-tone="ok">resolved{group.resolved_in ? ` in ${group.resolved_in}` : ""}</span>);
  if (!out.length && group?.status === "ignored") out.push(<span key="ign" className="otl-pill">ignored</span>);
  if (group?.status === "open") {
    // The same fix plan and words as the issue's row on the Ops home, its overview and its Fix card.
    out.push(<span key="start" className="otl-fix"><GroupFixSlots item={issueWorkItem(group, task)} group={group} bare /></span>);
  }
  return <span className="otl-outcome ops-ref-fit">{out}</span>;
}

/** The Codecast column folded into the Issue cell where the column has no room: one dot for tracked, fixing, or nobody on it. */
function issueState(group: OpsGroup | undefined): "fixing" | "tracked" | "open" | null {
  if (!group) return null;
  if (group.fix_conversation_id) return "fixing";
  if (group.signal_task_id) return "tracked";
  return group.status === "open" ? "open" : null;
}

function Row({ e, span, now, group, taskOf, provider, on, cursor, onOpen }: { e: OpsEvent; span: number; now: number; group?: OpsGroup; taskOf: (id: string) => AttentionTask | undefined; provider?: OpsSource["provider"]; on: boolean; cursor: boolean; onOpen: () => void }) {
  const st = e.data?.transition ?? e.kind;
  const kind = isReleaseMarker(e) ? "deploy" : e.data?.group_kind;
  const { level, type } = splitLevel(e.data?.level);
  const state = issueState(group);
  // "error error": a level that repeats the kind says nothing twice.
  const showKind = kind && kind !== "deploy" && kind !== level;
  return (
    <div className="otl-row" data-on={on ? "true" : undefined} data-cursor={cursor ? "true" : undefined} data-ops-row={e._id} data-ops-event={e._id} role="button" tabIndex={0} aria-expanded={on} onClick={(ev) => { if (ev.currentTarget.contains(ev.target as Node) && !(ev.target as Element).closest("a, button")) onOpen(); }} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onOpen(); } }}>
      <RowTime at={e.created_at} span={span} now={now} />
      <span className="otl-src">{provider && <ProviderIcon provider={provider} />}<span className="truncate">{eventSourceName(e)}</span></span>
      <span className="otl-what">
        <span className="otl-st" style={{ color: statusInk(st), background: `color-mix(in srgb, ${statusInk(st)} 12%, transparent)` }}>{statusWord(st)}</span>
        {showKind && <span className="otl-kind">{kindLabel(kind)}</span>}
        {level && <span className="otl-level" data-level={level}>{level}</span>}
        {type && <span className="otl-kind">{type.replace(/_/g, " ")}</span>}
      </span>
      <span className="otl-title truncate" title={e.title}>{e.title}{e.data?.count && e.data.count > 1 ? <span className="ops-dim ops-num"> ×{e.data.count.toLocaleString()}</span> : null}</span>
      <span className="otl-id ops-mono">{e.data?.group_short_id ? <Link href={opsHref.issue(e.data.group_short_id)}>{state && <i className="otl-id-dot" data-state={state} title={state === "fixing" ? "A session is fixing it" : state === "tracked" ? "Tracked in a task" : "Nobody is on it"} aria-hidden />}{e.data.group_short_id}</Link> : e.meta?.deploy ? null : <span className="ops-dim">-</span>}</span>
      <Outcome e={e} group={group} task={group?.signal_task_id ? taskOf(group.signal_task_id) : undefined} />
    </div>
  );
}

// ── The side panel ──

function EventPanel({ event: e, group, provider, taskOf, onClose }: { event: OpsEvent; group?: OpsGroup; provider?: OpsSource["provider"]; taskOf: (id: string) => AttentionTask | undefined; onClose: () => void }) {
  const replays = useOpsReplays();
  // A replay issue's event plays where it happened: the recording that showed it nearest the event, at that second.
  const replay = useMemo(() => (group ? nearestReplay(replays, group._id, e.created_at) : null), [replays, group, e.created_at]);
  const task = group?.signal_task_id ? taskOf(group.signal_task_id) : undefined;
  useWatchEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const st = e.data?.transition ?? e.kind;
  const d = e.data ?? {};
  const facts: [string, ReactNode][] = [
    ["When", fmtStamp(e.created_at)],
    ["Source", <span key="s" className="inline-flex items-center gap-1.5">{provider && <ProviderIcon provider={provider} />}{eventSourceName(e)}</span>],
    ["Status", statusWord(st)],
    ...(d.group_kind ? [["Kind", kindLabel(d.group_kind)] as [string, ReactNode]] : []),
    ...(d.level ? [["Level", d.level] as [string, ReactNode]] : []),
    ...(d.count != null ? [["Count", d.count.toLocaleString()] as [string, ReactNode]] : []),
    ...(d.value != null ? [["Value", `${d.value}${d.threshold != null ? ` (line ${d.threshold})` : ""}`] as [string, ReactNode]] : []),
    ...(d.release ? [["Release", <span key="r" className="ops-mono">{d.release}</span>] as [string, ReactNode]] : []),
    ...(d.environment ? [["Env", d.environment] as [string, ReactNode]] : []),
    ...(e.sha ? [["Commit", <span key="c" className="ops-mono">{e.sha.slice(0, 10)}</span>] as [string, ReactNode]] : []),
  ];
  return (
    <aside className="otl-panel" aria-label="Event" data-ops-event-panel>
      <div className="otl-panel-head">
        <span className="otl-st" style={{ color: statusInk(st), background: `color-mix(in srgb, ${statusInk(st)} 12%, transparent)` }}>{statusWord(st)}</span>
        <span className="flex-1" />
        <button type="button" className="otl-clear" aria-label="Close" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="otl-panel-title">{e.title}</div>
      <dl className="ops-kv">
        {facts.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
      </dl>
      {replay && <ReplayMoment replayRef={replay.short_id || replay._id} at={Math.max(replay.started_at, Math.min(e.created_at, replay.started_at + (replay.duration_ms ?? 0)))} />}
      {group && (
        <div className="otl-panel-group">
          <div className="ops-section-label">Issue</div>
          <Link href={opsHref.issue(group.short_id)} className="otl-panel-issue">
            <span className="ops-mono">{group.short_id}</span>
            <span className="truncate">{group.title}</span>
            <span className="ops-dim ops-num">{group.count.toLocaleString()}×</span>
          </Link>
          <div className="otl-panel-facts ops-dim ops-num">
            first {fmtStamp(group.first_seen)} · last {fmtStamp(group.last_seen)}
          </div>
          <IssueActs group={group} task={task} />
        </div>
      )}
      {e.meta?.deploy && (
        <div className="otl-panel-group">
          <div className="ops-section-label">Deploy</div>
          <EntityIdPill shortId={e.meta.deploy} type="deploy" />
        </div>
      )}
      {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="ops-btn self-start">Open at the source<ExternalLink className="w-3 h-3" /></a>}
    </aside>
  );
}

// ── Keys ──

/**
 * j/k (or the arrows) move a cursor through the rows, Enter opens the row
 * under it, and while a row is open the panel follows the cursor. Typing in a
 * field never moves it.
 */
function useListKeys(ids: readonly string[], cursor: string | null, setCursor: (id: string | null) => void, open: string | null, setOpen: (id: string | null) => void) {
  const state = useRef({ ids, cursor, open });
  state.current = { ids, cursor, open };
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return;
      const { ids: list, cursor: at, open: opened } = state.current;
      if (!list.length) return;
      const down = e.key === "j" || e.key === "ArrowDown";
      const up = e.key === "k" || e.key === "ArrowUp";
      if (down || up) {
        const i = list.indexOf(at ?? opened ?? "");
        const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (down ? 1 : -1)))];
        e.preventDefault();
        setCursor(next);
        if (opened) setOpen(next);
        const el = document.querySelector<HTMLElement>(`[data-ops-row="${CSS.escape(next)}"]`);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter" && at && list.includes(at) && !(e.target as Element | null)?.closest?.("a, button, [data-ops-row]")) {
        e.preventDefault();
        setOpen(opened === at ? null : at);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
