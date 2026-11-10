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
import Link from "next/link";
import { entityRoute } from "@codecast/shared/entities";
import { type CSSProperties, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronDown, ExternalLink, Radio, Search, SlidersHorizontal, Workflow, X } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  OPS_SAMPLE_PAGE,
  useOpsEvents,
  useOpsGroups,
  useOpsSources,
  useOpsStreamSamples,
  useSyncOpsEventPages,
  useSyncOpsEvents,
  useSyncOpsSourceOpenGroups,
  useSyncOpsStreamSamples,
} from "../../hooks/useSyncOps";
import { useAttentionTasks } from "./useOpsAttention";
import {
  admits,
  admitsSample,
  clusterSpan,
  dayRange,
  type Facet,
  FACET_LABEL,
  facetCounts,
  type FacetRow,
  FACETS,
  filterBeyond,
  fitPreset,
  fmtTime,
  fmtWindow,
  foldedIds,
  foldRepeats,
  formatRange,
  formatTimelineQuery,
  type HistBin,
  histogram,
  isEmptyFilter,
  isMidnight,
  laneClusters,
  markUnloaded,
  matchedOnly,
  hourlyVolumeBins,
  overlayBins,
  parseRange,
  parseTimelineQuery,
  RANGE_PRESETS,
  rangeTicks,
  type RowsView,
  sampleFacetCounts,
  sampleFacets,
  STACK_INK,
  streamAxis,
  streamDayBins,
  type StreamMode,
  tickBudget,
  type TimeRange,
  toggleFacet,
  vendorStreamUrl,
  windowDated,
} from "./timelineModel";
import { OccurrencePanel, OccurrenceRows } from "./TimelineOccurrences";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isEditableTarget } from "../../shortcuts";
import { eventSourceName, isReleaseMarker } from "./opsModel";
import { opsHref } from "./opsPaths";
import { OpsFeedEmpty, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, useOpsFeed } from "./parts";
import { type ChartMark, VolumeChart } from "./VolumeChart";
import { useWidth } from "./volumeChartLayout";
import type { OpsEvent, OpsGroup, OpsSample, OpsSource } from "./opsTypes";
import { BUCKET_REACH, HOUR, kindLabel, laneGutter, NO_SOURCE_LANE, spanText, statusInk, statusWord, tickLabel, useListKeys } from "./timelineTabModel";
import { EventPanel, Rows } from "./TimelineRows";
import "./sourceView.css";

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
    return hourlyVolumeBins(groups, ids, filter, range).reduce((n, b) => n + b.total, 0);
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

  // The lanes draw the rows the list shows (kept occurrences, or transitions), so each lane's marks add up to the count beside it.
  const laneMarks = useMemo<LaneMark[]>(() => {
    if (!occOn) return shown.filter((e) => !isReleaseMarker(e)).map((e) => {
      const st = e.data?.transition ?? e.kind;
      return { id: e._id, at: e.created_at, source: eventSourceName(e), ink: statusInk(st), word: statusWord(st), title: e.title, href: e.data?.group_short_id ? opsHref.issue(e.data.group_short_id) : null, lead: statusInk(st) === STACK_INK.new };
    });
    return samples.map((x) => {
      const g = groupById.get(x.group_id);
      const key = sampleKey(facetsOf(x));
      // The lane is the Source facet's value, so a lane and its facet row count the same rows under the same name.
      return { id: x._id, at: x.at, source: facetsOf(x).source ?? NO_SOURCE_LANE, ink: STACK_INK[key] ?? statusInk(key), word: key, title: x.message?.split("\n")[0] || g?.title || "occurrence", href: g ? opsHref.issue(g.short_id) : null, lead: false };
    });
  }, [occOn, shown, samples, groupById, sourceById, facetsOf]);
  // The lanes' name column fits the longest name and count drawn (laneGutter), so a name is never cut while the track has room.
  const gutter = useMemo(() => laneGutter(laneMarks.filter((m) => m.at >= laneAxis.from && m.at <= laneAxis.to).map((m) => m.source)), [laneMarks, laneAxis.from, laneAxis.to]);
  const dated = windowDated(range, now);
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
        <TimelineMain gutter={gutter}>{(stacked) => (<>
          <StreamChart now={now} dated={dated} mode={streamMode} setMode={setStreamMode} events={shown} rows={occOn ? samples.map((x) => ({ at: x.at, key: sampleKey(facetsOf(x)) })) : null} groups={groups} sources={sources} sourceIds={source ? new Set(scoped ? [scoped._id] : []) : facetSourceIds(filter.facets.source, sourceIdOf)} filter={filter} range={range} setRange={setRange} oldestLoaded={oldest} moreOlder={!exhausted} />
          <Lanes marks={laneMarks} range={laneAxis} dated={dated} providerOf={providerOf} q={q} setQuery={setQuery} setRange={setRange} scoped={!!source} unit={occOn ? "Kept rows" : "Transitions"} stacked={stacked} />
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
              dated={dated}
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
            dated={dated}
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
        </>)}</TimelineMain>
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
          {fmtWindow(range, now)}
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

function StreamChart({ events, rows, groups, sources, sourceIds, filter, range, setRange, oldestLoaded, moreOlder, mode, setMode, now, dated }: { now: number; dated: boolean; mode: StreamMode; setMode: (m: StreamMode) => void; events: OpsEvent[]; /** Occurrences: the kept samples the list shows; null for transitions (the events). */ rows: { at: number; key: string }[] | null; groups: OpsGroup[]; sources: OpsSource[]; sourceIds: Set<string> | null; filter: ReturnType<typeof parseTimelineQuery>; range: TimeRange; setRange: (r: TimeRange) => void; oldestLoaded: number | null; moreOlder: boolean }) {
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
    } else if (range.from < now - BUCKET_REACH) {
      // Past the hourly buckets' reach the server keeps no hourly count: the bars are the rows the list keeps, named as such.
      return { bins: histogram(listed, (p) => p.at, (p) => p.key, () => 1, range, width), chartRange: axisRange, what: rows ? "Kept occurrences per hour" : "Transitions per hour", matched: null };
    } else {
      b = hourlyVolumeBins(groups, sourceIds, filter, range, width);
      label = "Occurrences per hour";
      beyond = filterBeyond(filter, "groups");
    }
    const chartRange = axisRange;
    // The series cannot split by this filter: the matching rows go on top of a faint total, so the header and the bars move with the query.
    if (!beyond) return { bins: b, chartRange, what: label, matched: null };
    const over = overlayBins(b, listed);
    return { bins: over.bins, chartRange, what: label, matched: over.matched };
  }, [useVolume, daily, listed, rows, groups, sources, sourceIds, filter, range, width, axisRange, oldestLoaded, moreOlder, now]);
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
        <span className="text-meta ops-dim">{what}</span>
        {/* The total names its window, so a per-day label never reads as a day's count; per day also shows the average. */}
        <span className="ops-num text-meta" data-ops-chart-total title={matched !== null ? "Rows matching the filter, of everything the sources counted" : undefined}>{matched !== null ? `${matched.toLocaleString()} of ${total.toLocaleString()}` : total.toLocaleString()} <span className="ops-dim">in {spanText(range.to - range.from, range.preset)}</span></span>
        {useVolume && daily && bins.length > 1 && matched === null && <span className="ops-num text-meta ops-dim" data-ops-chart-avg>avg {Math.round(total / bins.length).toLocaleString()}/day</span>}
        {matched !== null && (
          <div className="ops-seg" role="group" aria-label="Bars show">
            <button type="button" data-on={!showAll ? "true" : undefined} aria-pressed={!showAll} onClick={() => setShowAll(false)} data-ops-chart-matching>Matching</button>
            <button type="button" data-on={showAll ? "true" : undefined} aria-pressed={showAll} onClick={() => setShowAll(true)} data-ops-chart-all>All</button>
          </div>
        )}
        <span className="flex-1" />
        <span className="ops-dim text-meta otl-hint">drag to zoom</span>
      </div>
      <VolumeChart bins={drawn} range={chartRange} marks={marks} onBrush={(from, to) => setRange({ from, to, preset: null })} height={84} label="stream" dated={dated} empty={`No ${what.split(" per ")[0].toLowerCase()} in this window`} />
    </section>
  );
}

// ── Lanes ──

/** One mark on a lane: a row the list shows (a kept occurrence or a transition), its ink, word and where it opens. */
type LaneMark = { id: string; at: number; source: string; ink: string; word: string; title: string; href: string | null; /** Leads its cluster's colour (a new issue). */ lead: boolean };

/** Below this width the lane names sit over their tracks at full width, so a long shared prefix never cuts them to "un…". */
const LANES_STACK_PX = 560;

/**
 * The stream's column, measured once it exists: narrow, the lanes stack and the
 * chart drops its name gutter with them (data-narrow), so both draw on one x scale.
 */
function TimelineMain({ gutter, children }: { gutter: number; children: (stacked: boolean) => ReactNode }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const stacked = w > 0 && w < LANES_STACK_PX;
  const style = stacked ? undefined : ({ "--otl-gutter": `${gutter}px` } as CSSProperties);
  return <div ref={ref} className="otl-main" data-narrow={stacked ? "true" : undefined} style={style}>{children(stacked)}</div>;
}

function Lanes({ marks: all, range, dated, providerOf, q, setQuery, setRange, scoped, unit, stacked }: { marks: LaneMark[]; range: TimeRange; dated: boolean; providerOf: Map<string, OpsSource["provider"]>; q: string; setQuery: (q: string) => void; setRange: (r: TimeRange) => void; scoped: boolean; /** What the marks are: kept rows or transitions, the list's unit. */ unit: string; stacked: boolean }) {
  const span = Math.max(1, range.to - range.from);
  const lanes = useMemo(() => {
    const xOf = (t: number) => Math.min(1, Math.max(0, (t - range.from) / span));
    const m = new Map<string, (LaneMark & { x: number })[]>();
    for (const e of all) {
      if (e.at < range.from || e.at > range.to) continue;
      if (!m.has(e.source)) m.set(e.source, []);
      m.get(e.source)!.push({ ...e, x: xOf(e.at) });
    }
    return [...m].sort((a, b) => b[1].length - a[1].length);
  }, [all, range.from, range.to, span]);
  if (!lanes.length) return null;
  return <LaneBoard lanes={lanes} range={range} span={span} dated={dated} providerOf={providerOf} q={q} setQuery={setQuery} setRange={setRange} scoped={scoped} unit={unit} stacked={stacked} />;
}

/** The lanes once there are any, so the widths they measure are read from elements that exist from their first paint. */
function LaneBoard({ lanes, range, span, dated, providerOf, q, setQuery, setRange, scoped, unit, stacked }: { lanes: [string, (LaneMark & { x: number })[]][]; range: TimeRange; span: number; dated: boolean; providerOf: Map<string, OpsSource["provider"]>; q: string; setQuery: (q: string) => void; setRange: (r: TimeRange) => void; scoped: boolean; unit: string; stacked: boolean }) {
  // The axis spans exactly the tracks, so its width is the room the marks cluster in.
  const [ref, trackW] = useWidth<HTMLDivElement>();
  const ticks = rangeTicks(range, tickBudget(trackW));
  return (
    // One source in scope keeps its name column too: the chart's plot starts after the same gutter, so a date is one line through both.
    <section className="ops-tl otl-lanes" aria-label={`${unit} by source`} data-stacked={stacked ? "true" : undefined}>
      {stacked && <div className="otl-lanes-unit-row" data-ops-lanes-unit>{unit}</div>}
      <div className="ops-tl-axis" ref={ref}>
        {!stacked && <span className="otl-lanes-unit" data-ops-lanes-unit>{unit}</span>}
        {ticks.map((t, i) => <span key={t.at} className="ops-tl-tick ops-num" style={{ left: `${t.x * 100}%` }}>{tickLabel(t.at, span, dated && (i === 0 || isMidnight(t.at)))}</span>)}
      </div>
      {lanes.map(([name, marks]) => {
        const head = (
          <>
            {providerOf.get(name) && <ProviderIcon provider={providerOf.get(name)!} />}
            <span className="truncate">{name}</span>
            <span className="ops-dim ops-num ml-auto" title={`${unit} in range`} data-ops-lane-n>{marks.length.toLocaleString()}</span>
          </>
        );
        return (
          <div key={name} className="ops-tl-lane" data-ops-lane={name}>
            {scoped || name === NO_SOURCE_LANE ? (
              <div className="ops-tl-name" title={name}>{head}</div>
            ) : (
              <button type="button" className="ops-tl-name otl-lane-name" title={`Only ${name}`} onClick={() => setQuery(toggleFacet(q, "source", name, true))}>{head}</button>
            )}
            <div className="ops-tl-track">
              {laneClusters(marks, trackW).map((c) => <Cluster key={c.marks[0].id} cluster={c} span={span} dated={dated} unit={unit} trackW={trackW} onZoom={() => setRange({ ...clusterSpan(c.marks.map((m) => ({ event: { created_at: m.at } }))), preset: null })} />)}
            </div>
          </div>
        );
      })}
    </section>
  );
}

const POP_ROWS = 12;

/** A bubble is placed by its centre in pixels (laneClusters holds it inside the track), so none is cut by the frame. */
function Cluster({ cluster, span, dated, unit, trackW, onZoom }: { cluster: { x: number; px: number; marks: LaneMark[] }; span: number; dated: boolean; unit: string; trackW: number; onZoom: () => void }) {
  const [pop, setPop] = useState(false);
  const marks = [...cluster.marks].sort((a, b) => b.at - a.at);
  const lead = marks.find((m) => m.lead) ?? marks[0];
  const many = marks.length > 1;
  const noun = unit.toLowerCase();
  const left = trackW > 0 ? `${cluster.px}px` : `${cluster.x * 100}%`;
  return (
    <span className="otl-cluster-wrap" style={{ left }} onMouseEnter={() => setPop(true)} onMouseLeave={() => setPop(false)} onFocus={() => setPop(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPop(false); }} data-edge={cluster.x > 0.7 ? "end" : undefined}>
      {!many && lead.href ? (
        <Link href={lead.href} className="ops-tl-mark otl-mark" style={{ background: lead.ink }} aria-label={lead.title} />
      ) : (
        <button type="button" className={many ? "ops-tl-cluster otl-mark" : "ops-tl-mark otl-mark"} style={{ background: lead.ink }} onClick={onZoom} aria-label={`${marks.length} ${noun}: zoom to them`}>{many ? <span className="ops-num">{marks.length}</span> : null}</button>
      )}
      {pop && (
        <span className="otl-pop" role="dialog" aria-label={`${marks.length} ${noun}`}>
          {marks.slice(0, POP_ROWS).map((m) => {
            const row = (
              <>
                <i style={{ background: m.ink }} />
                <span className="otl-pop-st">{m.word}</span>
                <span className="truncate">{m.title}</span>
                <span className="ops-dim ops-num">{fmtTime(m.at, span, dated)}</span>
              </>
            );
            return m.href ? <Link key={m.id} href={m.href} className="otl-pop-row">{row}</Link> : <span key={m.id} className="otl-pop-row">{row}</span>;
          })}
          {marks.length > POP_ROWS && <span className="otl-pop-more ops-dim">{marks.length - POP_ROWS} more</span>}
          {many && <button type="button" className="otl-pop-zoom" onClick={onZoom}>Zoom to these</button>}
        </span>
      )}
    </span>
  );
}
