// One source at a glance, what a source opens on: its health with the reason
// and the fix, the numbers a person checks first (last event, events today
// against the same counter's usual day, dropped, open issues, last poll), its
// volume over 24 hours, 7 days or 30 days with deploys drawn across, and its
// top open issues, newest replays and watches, each a link into its own page.
// Every count on it reads one counter: the day series for events, the open
// groups for issues, so a tile and the panel under it never disagree. The
// setup actions (pause, rotate the key, the recordings import, remove) sit
// here too, and a silent keyed source opens its test-event check in place.
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { entityRoute, formatCallTime } from "@codecast/shared/entities";
import { BellRing, ChevronDown, Pause, Play, Plus, Settings2 } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsApp, useOpsEvents, useOpsGroups, useOpsReplays, useOpsSources, useOpsWatches, useSyncOpsApp, useSyncOpsEvents, useSyncOpsSourceOpenGroups } from "../../hooks/useSyncOps";
import { parseAppManifest, watchKey, type AppManifest } from "@codecast/shared/contracts/appConnector";
import { appWatchVerdict, titleLookup, VERDICT_RANK, VERDICT_TONE, watchFailWord, watchVerdict, watchWordBreakdown, type WatchVerdict } from "./appsModel";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { useRouter } from "next/navigation";
import { RemoveSourceButton } from "./RemoveSource";
import { SparkLine } from "../Spark";
import { formatValue } from "./metricModel";
import { SourceCheck } from "./SourceCheck";
import { deliveryWord, isOpenProblem, isRunRecord, isSilenceWatch, issueWorkItem, knownSilence, paceLabel, paceVsUsual, rolling24, rollingLabel, shortShas, SILENCE_HOURS, silenceWatchInput, sourceSettingsHref, usualBefore, volumeBins, watchLine } from "./sourceViewModel";
import { GroupFixSlots, SilentFix, SourceFix } from "./OpsHomeRow";
import { useAttentionTasks, useIssueFailures } from "./useOpsAttention";
import { attentionLane, foldIssueRows, foldWeight, foldedTitle, issueLane } from "./issuesModel";
import { replayTitle } from "./opsModel";
import { isAnonymous, personKey, personLabel } from "@codecast/shared/replay";
import { PersonMark } from "./replayParts";
import { opsHref } from "./opsPaths";
import { KindGlyph, ProviderIcon, SOURCE_PROVIDER_LABEL } from "./parts";
import { hasVendorRecordings, ReplayImportLine } from "./ReplayImport";
import { NewWatchSheet } from "./WatchEditor";
import { watchKindsOf } from "./watchQuery";
import { HealthFixButton } from "./SourceHealthParts";
import { BASELINE_DAYS, eventCounter, healthDayKeys, pollLateAfter } from "./sourceHealth";
import { KeyReveal, type Reveal } from "./SourcesSection";
import { RotateKeyButton } from "./RotateKey";
import { fillEstimates, histogram, occurrencePoints, STACK_INK, type HistBin, type TrailPoint } from "./timelineModel";
import { useSourceHealth } from "./useSourceHealth";
import { replayCountShown, replayTotalText, useReplayTotal } from "./useReplayTotals";
import { VolumeChart, type ChartMark } from "./VolumeChart";
import type { OpsGroup, OpsSource, OpsWatch } from "./opsTypes";
import "./sourceView.css";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const RANGES = ["24h", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];
const TOP = 5;
/** Issues the panel lists: one line each, so a working day's worth fits. */
const TOP_ISSUES = 8;

const ago = (at: number | null | undefined, now: number) => (at ? (relTimeShort(at, now) === "now" ? "just now" : `${relTimeShort(at, now)} ago`) : "never");

const INK: Record<string, string> = { events: "var(--sol-blue)", dropped: "var(--sol-text-dim)", replay: "var(--sol-cyan)" };

export function SourceOverview({ source, needs }: { source: OpsSource; /** What needs a person on this source (OpsHome's scoped list), drawn right under its header as the home draws it. */ needs?: ReactNode }) {
  useSyncOpsEvents();
  // An app's call log feeds its health (Degraded when readers keep failing), so the overview reads what the Apps board reads.
  useSyncOpsApp(source.provider === "app" ? source._id : null);
  // This source's open groups, vouched for by its own answer: an open row the workspace's capped feeder never reaches is corrected here.
  useSyncOpsSourceOpenGroups(source._id);
  const health = useSourceHealth(source);
  const groups = useOpsGroups();
  const replays = useOpsReplays();
  const watches = useOpsWatches();
  const events = useOpsEvents();
  const sources = useOpsSources();
  const [addingWatch, setAddingWatch] = useState(false);
  const now = useCoarseNow(60_000);
  // A check's flips over the events held: the count the attention strip, the badge and the Issues lanes read, so a flapping check is never "regressed" here alone.
  const failures = useIssueFailures(now);
  const laneOf = (g: OpsGroup) => issueLane(g, now, failures(g));
  const [picked, setRange] = useState<Range | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  // Settings' "Send a test" lands here with #check: the check opens in place.
  const [checking, setChecking] = useState(() => typeof window !== "undefined" && window.location.hash === "#check");
  const [watchingSilence, setWatchingSilence] = useState(false);
  const router = useRouter();

  const mine = useMemo(() => groups.filter((g) => g.source_id === source._id), [groups, source._id]);
  // A problem now: a check that passes and a superseded run record (a deploy CI filed as its own group) are not; those runs are drawn as deploys instead.
  const open = useMemo(() => mine.filter(isOpenProblem).sort((a, b) => b.last_seen - a.last_seen), [mine]);
  const runRecords = useMemo(() => mine.filter(isRunRecord), [mine]);
  const myReplays = useMemo(() => replays.filter((r) => r.source_id === source._id).slice(0, TOP), [replays, source._id]);
  const myWatches = useMemo(() => watches.filter((w) => w.source_id === source._id), [watches, source._id]);
  const replayTotal = useReplayTotal(source.name, hasVendorRecordings(source) || myReplays.length > 0);
  const appWatches = useMemo(() => source.watch_state ?? [], [source.watch_state]);
  // A manifest watch by the name the Apps board gives it (its reader's title); the raw key stays on hover.
  const app = useOpsApp(source.provider === "app" ? source._id : undefined);
  const watchTitle = useMemo(() => {
    let manifest: AppManifest | null = null;
    try {
      const parsed = app?.manifest_json ? parseAppManifest(JSON.parse(app.manifest_json)) : null;
      manifest = parsed?.ok ? parsed.manifest : null;
    } catch {
      manifest = null;
    }
    const titleOf = titleLookup(manifest);
    const byKey = new Map((manifest?.watches ?? []).map((w) => [watchKey(w), titleOf("read", w.reader)]));
    return (key: string) => byKey.get(key) ?? key;
  }, [app?.manifest_json]);
  // Every watch on this source, metric and app alike, under one reading (watchVerdict), worst first: the tile counts these rows and the panel lists them.
  const panelWatches = useMemo((): PanelWatch[] => {
    const rows: PanelWatch[] = myWatches.map((w) => ({ kind: "metric", key: w._id, verdict: watchVerdict(w), name: w.name, watch: w }));
    if (source.provider === "app") for (const w of appWatches) rows.push({ kind: "app", key: w.key, verdict: appWatchVerdict(w), name: watchTitle(w.key), state: w });
    return rows.sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || a.name.localeCompare(b.name));
  }, [myWatches, appWatches, source.provider, watchTitle]);
  const counter = useMemo(() => eventCounter(source, now), [source, now]);
  // The headline count: the last 24 hours of the series the 24h chart draws, against the 24 hours before.
  const roll = useMemo(() => rolling24(source, now), [source, now]);
  // One row per root cause, as the Ops home lists them (issuesModel foldIssueRows): a template bug's variants are one row with one fix.
  // The issues Needs attention lists above (attentionLane, the list's own rule) stay out of the panel: it holds the rest of what is open.
  const rest = useMemo(() => open.filter((g) => !attentionLane(g, now, failures(g))), [open, now, failures]);
  const causes = useMemo(() => foldIssueRows(rest, (g) => g, (g) => foldWeight(g, now)).slice(0, TOP_ISSUES), [rest, now]);
  const taskOf = useAttentionTasks(useMemo(() => causes.flat(), [causes]));
  // A silent source opens on 30 days, so the drop-off shows; a sending one on the last day.
  const silentNow = !!health && (health.state === "stopped" || health.state === "quiet");
  const range: Range = picked ?? (silentNow ? "30d" : "24h");

  const span = range === "24h" ? DAY : range === "7d" ? 7 * DAY : 30 * DAY;
  const r = { from: now - span, to: now };
  // What the client keeps of this source, as points: where the counter has no record of a day, the bars are drawn from these and marked estimated.
  const trails = useMemo((): TrailPoint[][] => {
    const keys = healthDayKeys(now);
    return [
      occurrencePoints(mine),
      replays.filter((x) => x.source_id === source._id).map((x) => ({ at: x.started_at, n: 1 })),
      events.filter((e) => e.source_id === source._id && e.kind !== "deploy").map((e) => ({ at: e.created_at, n: 1 })),
      mine.flatMap((g) => [{ at: g.first_seen, n: 1 }, ...(g.last_seen !== g.first_seen ? [{ at: g.last_seen, n: 1 }] : [])]),
      // Each issue's own daily counts (90 days kept): real history for the days before the counter began.
      mine.flatMap((g) => (g.days ?? []).map((d) => ({ at: d.day + 12 * HOUR, n: d.count }))),
      (health?.days ?? []).map((n, i) => ({ at: Date.parse(`${keys[i]}T12:00:00Z`), n })),
    ];
  }, [mine, replays, events, source._id, health?.days, now]);
  const lastAt = health?.lastAt ?? null;
  const bins = useMemo(() => {
    const counted = volumeBins(source, now, range);
    // An hour's bar takes only trails kept by the hour (issue buckets, replay starts); a day's takes every trail.
    // Past the last event the source is known to have sent nothing: those days are silence, not missing data.
    if (counted) return knownSilence(fillEstimates(counted, range === "24h" ? trails.slice(0, 2) : trails), lastAt);
    {
      const pts = [
        ...occurrencePoints(mine),
        ...replays.filter((x) => x.source_id === source._id).map((x) => ({ at: x.started_at, key: "replay", n: 1, source_id: source._id })),
      ];
      return histogram(pts, (p) => p.at, (p) => p.key, (p) => p.n, r, HOUR);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- r follows range and now
  }, [range, mine, replays, source, now, trails, lastAt]);
  // Deploys of this source's own app: its own markers, or those of a source on the same project.
  const projectOf = new Map(sources.map((x) => [x._id, x.project_id]));
  const sameApp = (id: string | undefined) => !!id && (id === source._id || (!!source.project_id && projectOf.get(id) === source.project_id));
  const marks: ChartMark[] = [
    ...events
      .filter((e) => e.kind === "deploy" && e.created_at >= r.from && sameApp(e.source_id))
      .map((e) => ({ at: e.created_at, label: e.meta?.deploy ?? e.data?.release ?? "deploy", href: e.meta?.deploy ? entityRoute("deploy", e.meta.deploy) ?? undefined : undefined })),
    // A deploy CI filed as its own group: a release marker on the chart, its run a click away.
    ...runRecords.filter((g) => g.last_seen >= r.from).map((g) => ({ at: g.last_seen, label: /^Deploy ([0-9a-f]{7})/.exec(g.title)?.[1] ?? "deploy", href: opsHref.issue(g.short_id), title: shortShas(g.title) })),
  ];

  if (!health) return null;
  // One count of open issues for the tile and the panel: the open groups themselves once the list holds any, else the server's counter.
  // The server's counter only while no group is held: it counts passing checks and run records the list leaves out.
  const openCount = mine.length ? open.length : source.groups_open ?? 0;
  const polled = health.polledAt;
  const dropped = source.dropped_today ?? 0;
  const stub = !source.short_id;
  const silent = health.state === "stopped" || health.state === "quiet" || health.state === "waiting";
  const store = () => useInboxStore.getState();
  // The counted total is the tile's number (the same hour counter over the same window). Where the counter holds nothing in range, the bars drawn from kept issues and replays are the count, so a known event is never "0".
  const countedTotal = bins.reduce((n, b) => (b.estimated ? n : n + b.total), 0);
  const estimated = bins.reduce((n, b) => (b.estimated ? n + b.total : n), 0);
  const total = countedTotal || estimated;
  const counted = !!volumeBins(source, now, range);
  const pace = paceLabel(paceVsUsual(counter.today, counter.baseline, now));
  // Regressed by the Issues list's Regressed lane (came back in the last 7d), so the tile, the row marks, the home's Regressed tile and the lane count the same groups.
  const regressed = open.filter((g) => laneOf(g) === "regressed").length;
  // Checks that pass now: the Issues list keeps them under Open as watched rows, so the tile names them beside the problems.
  const passing = mine.filter((g) => g.status === "open" && !isOpenProblem(g) && !isRunRecord(g)).length;
  // The source's one watch sentence (sourceHealth watches): the header, this tile and the Apps head say the same count in the same noun.
  const tally = health.watches;
  const watchTotal = tally.total;
  const firstNoLine = myWatches.find((w) => w.threshold === undefined)?.short_id ?? null;
  // What is wrong with them, by cause: "1 over 256 KB · 1 timed out".
  // Metric watches only: the app's own checks are their own noun (health.checks), named in the header.
  const watchWords = watchWordBreakdown(panelWatches.flatMap((w) => (w.kind === "metric" ? [{ verdict: w.verdict, error: w.watch.last_error }] : [])));
  const prior = health.state === "stopped" || health.state === "quiet" ? usualBefore(source, mine, health.lastAt) : null;
  const silenceWatch = myWatches.find(isSilenceWatch) ?? null;
  const watchSilence = async () => {
    setWatchingSilence(true);
    try {
      await store().createOpsWatch(silenceWatchInput(source));
    } finally {
      setWatchingSilence(false);
    }
  };
  // A source silent past the health reading's 14 days still says what it used to send, from the history its issues and counter keep.
  const reason = health.reason && prior && !health.normal && /^Nothing since/.test(health.reason) ? `${health.reason}; it sent about ${prior.toLocaleString()} a day before` : health.reason;
  const canWatch = watchKindsOf(source.provider).length > 0 && !stub;
  // A panel shows only once it holds something (replays a vendor records count from the start); an empty watch list is the tile's Watch a number, so the issues take the width.
  const canReplay = hasVendorRecordings(source) || myReplays.length > 0;
  const showWatches = panelWatches.length > 0;
  const appCheckRows = panelWatches.filter((w) => w.kind === "app").length;
  const cols = 1 + Number(canReplay) + Number(showWatches);
  const appsHref = opsHref.tab("apps", { app: source.short_id || source.name });
  const allWatchesHref = source.provider === "app" ? appsHref : opsHref.tab("metrics", { source: source.name });

  return (
    <section className="sov" aria-label={`${source.name} overview`} data-ops-source-overview={source.name}>
      <div className="sov-head">
        <div className="sov-state" data-health={health.tone}>
          <div className="sov-state-line" data-ops-health={health.state}>
            <i aria-hidden />
            {health.label}
            <span className="ops-dim text-[12px] font-normal inline-flex items-center gap-1.5"><ProviderIcon provider={source.provider} />{SOURCE_PROVIDER_LABEL[source.provider]} · <span className="ops-mono">{source.short_id}</span></span>
          </div>
          {health.starves ? (
            // A failing reader as structure: what fails and how often, and the watches it leaves blind, a click into the Apps board.
            <div className="sov-reason sov-cause" title={reason ?? undefined} data-ops-health-reason>
              <span className="ops-mono">{health.starves.reader.name}</span>
              {(health.starves.reader.reasons ?? [{ reason: health.starves.reader.reason, count: health.starves.reader.count }]).slice(0, 2).map((x) => <span key={x.reason} className="sov-cause-tag ops-num">{x.reason} {x.count.toLocaleString()}×</span>)}
              {health.starves.watchIds.length > 0 && <Link href={opsHref.tab("apps", { app: source.short_id || source.name })} className="sov-cause-blind">{health.starves.watchIds.length.toLocaleString()} {health.starves.watchIds.length === 1 ? "watch" : "watches"} without an answer</Link>}
            </div>
          ) : reason ? <div className="sov-reason" title={reason} data-ops-health-reason>{reason}</div> : null}
        </div>
        <div className="sov-acts">
          <HealthFixButton source={source} health={health} primary={!health.problems?.length} onCheck={() => setChecking((c) => !c)} />
          {/* An app's failing readers, actions and checks go to an agent from here, the same Start fix its row in Needs attention and the Apps board offer. */}
          {!stub && !!health.problems?.length && <SourceFix source={source} health={health} />}
          {!stub && (health.state === "stopped" || health.state === "quiet") && <SilentFix source={source} lastAt={health.lastAt} usual={prior} />}
          {!stub && silentNow && canWatch && !silenceWatch && (
            <button type="button" className="ops-btn" disabled={watchingSilence} onClick={() => void watchSilence()} title={`A watch that alerts once ${source.name} sends nothing for ${SILENCE_HOURS} hours in a row`} data-ops-silence-watch>
              <BellRing className="w-3.5 h-3.5" />{watchingSilence ? "Adding" : `Alert if silent ${SILENCE_HOURS}h`}
            </button>
          )}
          {silenceWatch && silentNow && <Link href={opsHref.metric(silenceWatch.short_id || silenceWatch._id)} className="ops-btn" data-ops-silence-watch="on"><BellRing className="w-3.5 h-3.5" />{silenceWatch.name}</Link>}
          {/* Pausing a source that is already silent changes nothing; it stays for one that is sending. */}
          {!stub && health.fix !== "resume" && (source.status !== "active" || !silent) && (
            <button type="button" className="ops-btn" onClick={() => store().setOpsSourceStatus(source._id, source.status === "active" ? "paused" : "active")}>
              {source.status === "active" ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {source.status === "active" ? "Pause" : "Resume"}
            </button>
          )}
          {source.keyed && !stub && (
            <RotateKeyButton source={source} events24h={roll?.last ?? counter.today} onRotated={setReveal} className="ops-btn" icon />
          )}
          <Link href={sourceSettingsHref(source.short_id)} className="ops-btn" title={`${source.name}'s settings`}><Settings2 className="w-3.5 h-3.5" />Settings</Link>
          {!stub && <RemoveSourceButton source={source} className="ops-btn" icon onRemoved={() => router.push(opsHref.home())} />}
        </div>
      </div>

      {reveal?.key && <KeyReveal reveal={{ ...reveal, key: reveal.key }} onDone={() => setReveal(null)} />}
      {checking && <SourceCheck source={source} lastAt={source.last_event_at ?? null} onClose={() => setChecking(false)} />}
      {needs}

      <div className="sov-facts" role="list" aria-label={`${source.name} at a glance`} style={{ ["--sov-n" as string]: 4 + Number(watchTotal > 0 || canWatch) }}>
        <Fact label="last event" value={ago(health.lastAt, now)} tone={health.state === "stopped" ? "bad" : health.state === "quiet" ? "warn" : undefined} title={health.lastAt ? new Date(health.lastAt).toLocaleString() : undefined} />
        {roll ? (
          <Fact
            label="events, last 24h"
            value={roll.last.toLocaleString()}
            sub={[rollingLabel(roll) ?? (silent && !roll.last ? (prior ? `usual about ${prior.toLocaleString()}` : undefined) : roll.prev === null ? "no full 24h before" : undefined), dropped ? `${dropped.toLocaleString()} dropped` : null].filter(Boolean).join(" · ") || undefined}
            tone={roll.vs === "spike" ? "bad" : roll.vs === "low" || dropped ? "warn" : undefined}
            title={`What ${source.name} sent in the last 24 hours: ${VOLUME_WHAT[source.provider] ?? "events"}.${roll.prev !== null ? ` The 24 hours before: ${roll.prev.toLocaleString()}.` : ""}${dropped ? ` ${dropped.toLocaleString()} dropped today.` : ""}`}
            data-ops-stat="today"
          />
        ) : (
          <Fact
            label="events today"
            value={counter.today.toLocaleString()}
            sub={[pace ?? (counter.baseline !== null ? `usual ${counter.baseline.toLocaleString()}` : counter.since ? `since ${shortDay(counter.since)}` : undefined), dropped ? `${dropped.toLocaleString()} dropped` : null].filter(Boolean).join(" · ") || undefined}
            tone={counter.vs === "spike" ? "bad" : counter.vs === "low" || dropped ? "warn" : undefined}
            title={`What ${source.name} sent today (UTC): ${VOLUME_WHAT[source.provider] ?? "events"}.${counter.baseline !== null ? ` Usual is the median of the last ${counter.baselineDays} full days, ${counter.baseline.toLocaleString()}.` : " Not enough history for a usual day yet."}${dropped ? ` ${dropped.toLocaleString()} dropped today.` : ""}`}
            data-ops-stat="today"
          />
        )}
        <Fact label="open issues" title={regressed ? "Regressed: came back after a resolve in the last 7d, the Issues list's Regressed lane" : undefined} value={openCount.toLocaleString()} sub={[regressed ? `${regressed} regressed` : null, passing ? `${passing} ${passing === 1 ? "check" : "checks"} passing` : null].filter(Boolean).join(" · ") || undefined} tone={regressed ? "bad" : openCount ? "warn" : "ok"} href={opsHref.tab("issues", { source: source.name })} data-ops-stat="open" />
        {watchTotal > 0 ? (
          tally.unjudged ? (
            // Nothing judged yet: the count in neutral ink, a press into the first watch's line.
            <Fact label={tally.label} value={watchTotal.toLocaleString()} title={tally.text} tone="off" href={firstNoLine ? `${opsHref.metric(firstNoLine)}#mx-line` : allWatchesHref} data-ops-stat="alerting" />
          ) : (
            // Always the watches ok of all of them; what is wrong with the rest is named under it.
            <Fact label={tally.label} value={`${tally.value.toLocaleString()}/${watchTotal.toLocaleString()}`} sub={(tally.bad ? [watchWords, tally.noLine ? `${tally.noLine.toLocaleString()} no line` : ""].filter(Boolean).join(" · ") || tally.sub : tally.sub) || undefined} title={tally.text} tone={tally.tone} href={allWatchesHref} data-ops-stat="alerting" />
          )
        ) : canWatch ? (
          <Fact label="watches" value="None" sub="+ Watch a number" onClick={() => setAddingWatch(true)} data-ops-stat="alerting" />
        ) : null}
        <Fact label={polled !== null ? "last poll" : "delivery"} value={polled !== null ? ago(polled, now) : deliveryWord(source)} sub={polled !== null || health.lastAt ? undefined : "none yet"} tone={polled !== null && source.status === "active" && now - polled > pollLateAfter(source, watches) ? "warn" : undefined} data-ops-stat="poll" />
      </div>

      <div className="sov-chart">
        <div className="sov-chart-head">
          {counted ? (range === "24h" ? "Events per hour" : "Events per day") : "Occurrences per hour"}
          <span className="ops-dim ops-num font-normal" data-ops-chart-total><span title={estimated > 0 ? `${countedTotal.toLocaleString()} counted, ${estimated.toLocaleString()} more drawn from the issues and replays kept, where the counter has no record` : undefined}>{total.toLocaleString()} in {range}</span></span>
          <span className="flex-1" />
          <div className="ops-seg" role="group" aria-label="Range">
            {RANGES.map((k) => <button key={k} type="button" data-on={range === k ? "true" : undefined} aria-pressed={range === k} onClick={() => setRange(k)}>{k}</button>)}
          </div>
          <Link href={opsHref.tab("timeline", { source: source.name })} className="ops-btn">Stream</Link>
        </div>
        <VolumeChart bins={bins} range={r} marks={marks} height={92} ink={(k) => INK[k] ?? STACK_INK[k] ?? "var(--sol-text-muted)"} empty={health.lastAt && health.lastAt >= r.from ? undefined : `Nothing from ${source.name} in ${range}`} label={source.name} silence={silentNow && health.lastAt ? { from: health.lastAt, label: `Silent ${relTimeShort(health.lastAt, now)}` } : null} />
      </div>

      {hasVendorRecordings(source) && <div className="sov-setup"><ReplayImportLine source={source} /></div>}

      <div className="sov-grid" data-cols={cols}>
        <section className="ops-card sov-panel" aria-label="Open issues">
          <div className="ops-card-head"><span>Open issues <span className="ops-dim ops-num font-normal">{openCount.toLocaleString()}</span></span><Link href={opsHref.tab("issues", { source: source.name })}>All</Link></div>
          {causes.length ? causes.map(([g, ...twins]) => <IssueRow key={g._id} group={g} variants={twins.length ? [g, ...twins] : undefined} task={g.signal_task_id ? taskOf(g.signal_task_id) : undefined} now={now} lane={laneOf(g)} />) : <div className="sov-none">{open.length ? "All in Needs attention" : "No open issues"}</div>}
          {/* The head's count less the rows drawn here: the issues Needs attention lists are among the "more", so the two always add up to the head. */}
          {openCount > causes.flat().length && causes.length > 0 && <Link href={opsHref.tab("issues", { source: source.name })} className="sov-more" data-ops-issues-more>+{(openCount - causes.flat().length).toLocaleString()} more</Link>}
        </section>
        {canReplay && <section className="ops-card sov-panel" aria-label="Newest replays">
          {/* The Replays tab badge's own count (useReplayTotal), so both say the same number. */}
          <div className="ops-card-head"><span>Newest replays {replayTotal && replayTotal.total > 0 && <span className="ops-dim ops-num font-normal" data-ops-replays-total>{replayTotalText(replayTotal)}</span>}</span><Link href={opsHref.tab("replays", { source: source.name })}>All</Link></div>
          {myReplays.length ? myReplays.map((x) => {
            return (
              <Link key={x._id} href={opsHref.replay(x.short_id)} className="sov-item sov-replay" data-ops-replay={x.short_id}>
                {/* The person as the Replays list names them: email or name, else the same readable handle for the same anonymous id. */}
                <PersonMark label={personLabel(x.user)} personKey={personKey(x.user)} anonymous={isAnonymous(x.user)} size={18} />
                <span className="sov-replay-main">
                  <span className="truncate" title={replayTitle(x)}>{replayTitle(x) ?? x.short_id}</span>
                  <span className="sov-replay-who truncate" title={x.user?.id ?? undefined}>{personLabel(x.user)}</span>
                </span>
                <span className="sov-replay-facts ops-num">
                  {x.counts.errors > 0 && <span className="sov-replay-n" data-tone="bad" title={`${x.counts.errors} errors`}>{x.counts.errors.toLocaleString()} err</span>}
                  {x.counts.failed_requests > 0 && <span className="sov-replay-n" data-tone="warn" title={`${x.counts.failed_requests} failed requests`}>{x.counts.failed_requests.toLocaleString()} req</span>}
                  <span className="ops-dim">{x.duration_ms ? formatCallTime(x.duration_ms) : ""}</span>
                  <span className="ops-dim" title={new Date(x.started_at).toLocaleString()}>{relTimeShort(x.started_at, now)}</span>
                </span>
              </Link>
            );
          }) : <div className="sov-none">No replays yet</div>}
          {replayTotal && myReplays.length > 0 && replayCountShown(replayTotal) > myReplays.length && <Link href={opsHref.tab("replays", { source: source.name })} className="sov-more" data-ops-replays-more>{replayTotal.capped ? `${(replayCountShown(replayTotal) - myReplays.length).toLocaleString()}+` : `+${(replayTotal.total - myReplays.length).toLocaleString()}`} more</Link>}
        </section>}
        {showWatches && <section className="ops-card sov-panel" aria-label="Watches">
          <div className="ops-card-head">
            {/* The tile's two nouns, so the rows under them add up: metric watches, and an app's own checks. */}
            <span data-ops-watches-head>Watches <span className="ops-dim ops-num font-normal">{(panelWatches.length - appCheckRows).toLocaleString()}</span>{appCheckRows > 0 && <> <span className="ops-dim font-normal">·</span> Checks <span className="ops-dim ops-num font-normal">{appCheckRows.toLocaleString()}</span></>}</span>
            <span className="flex-1" />
            {canWatch && <button type="button" className="sov-head-btn" onClick={() => setAddingWatch(true)} data-ops-add-watch><Plus className="w-3 h-3" />Watch</button>}
            <Link href={allWatchesHref}>All</Link>
          </div>
          {panelWatches.slice(0, TOP).map((w) => <WatchItem key={w.key} w={w} appHref={appsHref} now={now} />)}
          {panelWatches.length > TOP && <Link href={allWatchesHref} className="sov-more" data-ops-watches-more>+{(panelWatches.length - TOP).toLocaleString()} more</Link>}
          {!panelWatches.length && (
            <div className="sov-none sov-none-act">
              <span>No watches</span>
              {canWatch && <button type="button" className="ops-btn" data-size="sm" onClick={() => setAddingWatch(true)}><Plus className="w-3.5 h-3.5" />Watch a number</button>}
            </div>
          )}
        </section>}
      </div>
      {addingWatch && <NewWatchSheet sources={sources} initialSource={source.name} onClose={() => setAddingWatch(false)} />}
    </section>
  );
}

const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** What "events" means for each kind of source: what it sent, counted once. */
const VOLUME_WHAT: Partial<Record<OpsSource["provider"], string>> = {
  posthog: "recordings imported and the issues they showed",
  sentry: "new occurrences of its issues",
  github: "finished workflow runs on default branches",
  app: "items its watches turned into checks and jobs",
};

function Fact({ label, value, tone, href, onClick, sub, title, ...rest }: { label: string; value: string; tone?: "bad" | "warn" | "ok" | "off"; href?: string; onClick?: () => void; sub?: string; title?: string; "data-ops-stat"?: string }) {
  const body = (
    <>
      <span className="sov-fact-v ops-num">{value}{sub && <small>{sub}</small>}</span>
      <span className="sov-fact-l">{label}</span>
    </>
  );
  if (onClick) return <button type="button" role="listitem" className="sov-fact" data-tone={tone} title={title} onClick={onClick} {...rest}>{body}</button>;
  return href ? (
    <Link href={href} role="listitem" className="sov-fact" data-tone={tone} title={title} {...rest}>{body}</Link>
  ) : (
    <div role="listitem" className="sov-fact" data-tone={tone} title={title} {...rest}>{body}</div>
  );
}

/** An open issue with the work on it: its task and who has it, the session fixing it, or Fix while nobody is on it. */
function IssueRow({ group: g, variants, task, now, lane }: { group: OpsGroup; /** The issues one root cause produced, this one first (foldIssueRows). */ variants?: OpsGroup[]; task: ReturnType<ReturnType<typeof useAttentionTasks>>; now: number; /** Its Issues lane, read with the same failure count as the strip. */ lane: ReturnType<typeof issueLane> }) {
  const item = useMemo(() => ({ ...issueWorkItem(g, task), ...(variants ? { variants } : {}) }), [g, task, variants]);
  const [open, setOpen] = useState(false);
  const title = shortShas(variants ? foldedTitle(variants.map((v) => v.title)) : g.title);
  const count = variants ? variants.reduce((n, v) => n + v.count, 0) : g.count;
  return (
    <>
      <div className="sov-item sov-issue" data-ops-issue={g.short_id} data-ops-variants={variants?.length}>
        <KindGlyph kind={g.kind} />
        <Link href={opsHref.issue(g.short_id)} className="truncate sov-issue-title" title={title}>{title}</Link>
        <span className="sov-item-meta ops-num">
          {lane === "regressed" ? <span className="sov-regressed">regressed · </span> : lane === "flapping" ? <span className="sov-flapping">flapping · </span> : null}
          {variants && <button type="button" className="sov-variants" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-ops-variants-toggle>{variants.length} variants<ChevronDown className="w-3 h-3" aria-hidden /></button>}
          {count.toLocaleString()}× · {relTimeShort(g.last_seen, now)}
        </span>
        {/* The same task, press and menu the Ops home's row offers for this issue: one fix plan everywhere. */}
        <span className="sov-work ops-home-acts-lite"><GroupFixSlots item={item} group={g} /></span>
      </div>
      {variants && open && (
        <ul className="sov-variant-list" data-ops-variant-list>
          {variants.map((v) => (
            <li key={v._id}>
              <Link href={opsHref.issue(v.short_id || v._id)} className="sov-variant" data-ops-variant={v.short_id} title={v.title}>
                <span className="ops-mono ops-dim">{v.short_id}</span>
                <span className="truncate">{shortShas(v.title)}</span>
                <span className="ops-dim ops-num">{v.count.toLocaleString()}× · {relTimeShort(v.last_seen, now)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

type PanelWatch =
  | { kind: "metric"; key: string; verdict: WatchVerdict; name: string; watch: OpsWatch }
  | { kind: "app"; key: string; verdict: WatchVerdict; name: string; state: NonNullable<OpsSource["watch_state"]>[number] };

const VERDICT_WORD: Record<WatchVerdict, string> = { alerting: "alerting", failing: "failing", retrying: "failing", waiting: "no reading yet", ok: "ok", paused: "paused" };

/** One watch in the panel: its dot from the same reading the tile counts, its number (dimmed once its last read failed) and its line. */
function WatchItem({ w, appHref, now }: { w: PanelWatch; appHref: string; now: number }) {
  const tone = VERDICT_TONE[w.verdict];
  if (w.kind === "app") {
    const st = w.state;
    return (
      <Link href={appHref} className="sov-item sov-watch" data-ops-watch-verdict={w.verdict}>
        <span className="ops-health" data-health={tone} title={VERDICT_WORD[w.verdict]}><i aria-hidden /></span>
        <span className="truncate" title={st.last_error ?? st.key}>{w.name}</span>
        <span className="sov-spark" aria-hidden />
        <span className="sov-item-meta" data-verdict={w.verdict}>{w.verdict === "ok" ? (st.polled_at ? ago(st.polled_at, now) : "not yet") : watchFailWord(w.verdict, st.last_error) ?? VERDICT_WORD[w.verdict]}</span>
      </Link>
    );
  }
  const x = w.watch;
  const line = watchLine(x);
  const values = x.points.slice(-48).map((p) => p.value);
  const alerting = w.verdict === "alerting";
  const stale = w.verdict === "retrying" || w.verdict === "failing";
  // Reading fine with no line to judge it by: unjudged, "No line" as the band, the Metrics filter and the Apps board say, never a green OK.
  const noLine = w.verdict === "ok" && x.threshold === undefined;
  return (
    <Link href={opsHref.metric(x.short_id || x._id)} className="sov-item sov-watch" data-ops-watch={x.short_id} data-ops-watch-verdict={w.verdict}>
      <span className="ops-health" data-health={noLine ? "off" : tone} title={noLine ? "No line" : VERDICT_WORD[w.verdict]}><i aria-hidden /></span>
      <span className="truncate" title={x.last_error ? `${x.name}\n${x.last_error}` : x.name}>{x.name}</span>
      <span className="sov-spark" aria-hidden>{values.length > 1 ? <SparkLine values={values} target={x.threshold ?? null} width={56} height={16} tone={alerting ? "var(--sol-red)" : "var(--sol-text-muted)"} label={x.name} /> : null}</span>
      <span className="sov-item-meta ops-num" title={stale ? `Last read failed${x.last_at ? `; this value is from ${ago(x.last_at, now)}` : ""}` : line ?? undefined}>
        {stale && <span className="sov-watch-why" data-verdict={w.verdict}>{watchFailWord(w.verdict, x.last_error) ?? VERDICT_WORD[w.verdict]} · </span>}
        <b className="sov-watch-v" data-alert={alerting ? "true" : undefined} data-stale={stale ? "true" : undefined}>{x.last_value != null ? formatValue(x.last_value, x.unit) : VERDICT_WORD.waiting}</b>
        {line && <span className="ops-dim sov-watch-line"> · {line}</span>}
      </span>
    </Link>
  );
}

