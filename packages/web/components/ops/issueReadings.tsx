// What a check or metric issue reported, and what drives a metric alert.
// A check or metric keeps readings, not events: the Readings card lists them
// with what each one said (a metric's value against its line, an app check's
// message, a CI run's commit and conclusion), so the page's center shows the
// readings instead of a stepper over timestamps. The Contributors card ranks
// the error groups that fired inside a metric alert's window, each with its
// own fix stage and a fix one press away.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, EyeOff, RotateCcw, Wand2 } from "lucide-react";
import { parseAppManifest, watchKey } from "@codecast/shared/contracts/appConnector";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { useOpsApp, useOpsGroups, useOpsSources, useSyncOpsApp } from "../../hooks/useSyncOps";
import { commitPath } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import { opsHref } from "./opsPaths";
import { causeSearchHref } from "./issueNav";
import { SourceChip } from "./parts";
import { FixReview, FixStageGlyph } from "./issueParts";
import { useProblemTask } from "./useIssueFix";
import { leaveOutOfWatch } from "./issueUndo";
import { hogqlExclude, lastDayStart, noiseOf, stageFixLabel, type FailurePart, type FailureSplit, taskFixStage, foldReadings, metricContributors, parseTags, readingRows, trendZero, readingTemplate, type BreakdownRow, type Contributor, type ReadingColumn, type ReadingRow, type ReadingTemplate } from "./issuesModel";
import type { MetricBreakdown } from "./useMetricBreakdown";
import type { OpsGroup, OpsSample, OpsSource, OpsWatch } from "./opsTypes";

const fmtValue = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : Number(n.toPrecision(3)).toLocaleString());

/** The kept readings of a check or metric, newest first, alike runs folded. */
export function ReadingsCard({ group, samples, watch, now, loading, pickedRun, onPickRun, source }: { group: OpsGroup; samples: OpsSample[]; watch?: OpsWatch | null; now: number; loading?: boolean; /** The CI run the page shows; a run's row opens it there. */ pickedRun?: string | null; onPickRun?: (runId: string) => void; /** The check's source: an app's checks run again from here. */ source?: OpsSource }) {
  const line = { threshold: watch?.threshold ?? group.meta?.threshold, direction: watch?.direction ?? group.meta?.direction };
  const raw = useMemo(() => readingRows(group, samples, line), [group, samples, line.threshold, line.direction]); // eslint-disable-line react-hooks/exhaustive-deps
  // An app check that says one sentence with moving figures: the sentence once, the figures as columns and a trend.
  const template = useMemo(() => (group.kind === "check" && !raw.some((r) => r.run) ? readingTemplate(raw) : null), [group.kind, raw]);
  const rows = useMemo(() => foldReadings(raw), [raw]);
  const [all, setAll] = useState(false);
  const repository = useMemo(() => {
    for (const s of samples) {
      const r = parseTags(s.context_json)?.repository;
      if (typeof r === "string") return r;
    }
    return null;
  }, [samples]);
  const scale = useMemo(() => Math.max(line.threshold ?? 0, ...rows.map((r) => r.value ?? 0)) || 1, [rows, line.threshold]);
  const unit = watch?.unit ? ` ${watch.unit}` : "";
  if (loading) return null;
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <span>Readings <span className="ops-dim ops-num">{samples.length}</span></span>
        {group.kind === "metric" && line.threshold !== undefined && <span className="ops-dim font-normal text-meta ops-num">line {line.direction === "below" ? "below" : "above"} {fmtValue(line.threshold)}{unit}</span>}
        {group.kind === "check" && <span className="ops-dim font-normal text-meta">failures kept</span>}
        {source?.provider === "app" && <AppCheckActions source={source} />}
      </div>
      {template && <ReadingTrend template={template} rows={raw} now={now} />}
      {rows.length === 0 ? (
        <div className="ops-card-body ops-dim text-[12px]">No readings kept</div>
      ) : (
        <ol className="iss-readings" role="list">
          {template && (
            <li className="iss-reading iss-reading-head" aria-hidden>
              <span />
              <span />
              <span className="iss-reading-figs" style={{ gridTemplateColumns: `repeat(${template.cols.length}, minmax(0, 1fr))` }}>
                {template.cols.map((c) => <span key={c.label}>{c.label}</span>)}
              </span>
              <span />
            </li>
          )}
          {shown.map((r) => (
            <li
              key={r.id}
              className="iss-reading"
              data-failing={r.failing === null ? undefined : r.failing ? "true" : "false"}
              data-pickable={onPickRun && r.run?.run_id ? "true" : undefined}
              data-on={pickedRun && r.run?.run_id === pickedRun ? "true" : undefined}
              onClick={onPickRun && r.run?.run_id ? (e) => { if (!(e.target as HTMLElement).closest("a")) onPickRun(r.run!.run_id!); } : undefined}
            >
              <span className="iss-reading-at ops-num" title={new Date(r.at).toLocaleString()}>
                {new Date(r.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                <span className="ops-dim">{relTimeShort(r.at, now)}</span>
              </span>
              <i className="iss-reading-dot" aria-label={r.failing === null ? "unknown" : r.failing ? "failing" : "passing"} />
              {template?.values.get(r.id) ? (
                <span className="iss-reading-figs ops-num" style={{ gridTemplateColumns: `repeat(${template.cols.length}, minmax(0, 1fr))` }}>
                  {template.values.get(r.id)!.map((v, i) => <span key={i}><b>{figure(v, template.cols[i])}</b></span>)}
                </span>
              ) : r.value !== null ? (
                <span className="iss-reading-metric">
                  <b className="ops-num">{fmtValue(r.value)}{unit}</b>
                  <span className="iss-reading-bar" aria-hidden>
                    <i style={{ width: `${Math.min(100, (r.value / scale) * 100)}%` }} />
                    {line.threshold !== undefined && <u style={{ left: `${Math.min(100, (line.threshold / scale) * 100)}%` }} />}
                  </span>
                </span>
              ) : r.run ? (
                <span className="iss-reading-run">
                  <span className="iss-reading-concl">{r.run.conclusion}</span>
                  {r.run.sha && <ShaRef sha={r.run.sha} href={repository ? commitPath({ repository, sha: r.run.sha }) : null} />}
                  {r.run.branch && <span className="ops-mono ops-dim">{r.run.branch}</span>}
                  {r.run.url && <a href={r.run.url} target="_blank" rel="noopener noreferrer" className="iss-reading-link">run{r.run.run_id ? ` ${r.run.run_id.slice(-6)}` : ""} <ExternalLink className="w-3 h-3" /></a>}
                </span>
              ) : (
                <span className="iss-reading-text" title={r.text}>{r.text || <span className="ops-dim">failed</span>}</span>
              )}
              {/* Every row holds the count's cell, empty when it read once, so the columns line up down the card. */}
              <span className="iss-reading-n ops-num" title={r.n > 1 ? `the same reading ${r.n} times since ${new Date(r.oldest).toLocaleString()}` : undefined}>{r.n > 1 ? `${r.n} reads` : ""}</span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > 8 && <button type="button" className="iss-more px-3 pb-2" onClick={() => setAll((v) => !v)}>{all ? "Fewer" : `All ${samples.length}`}</button>}
    </div>
  );
}

/** A figure the way its reading wrote it: the currency sign before, a rate unit after. */
function figure(v: number, c: ReadingColumn): string {
  const n = Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Number(v.toPrecision(3)).toLocaleString();
  return `${c.pre}${n}${c.post}`;
}

/**
 * The first moving figure over time against the level the check holds it to,
 * and, when it is falling, where it reaches zero at that rate. The sentence
 * itself is the page's, under the title.
 */
function ReadingTrend({ template, rows, now }: { template: ReadingTemplate; rows: ReadingRow[]; now: number }) {
  const [picked, setPicked] = useState(template.charted);
  const at = Math.min(picked, template.cols.length - 1);
  const col = template.cols[at];
  // The level is the first column's: another column's chart draws no line it was never held to.
  const line = at === 0 ? template.line : null;
  const held = rows.flatMap((r) => (template.values.get(r.id) ? [{ at: r.at, v: template.values.get(r.id)![at] }] : [])).sort((a, b) => a.at - b.at);
  // Kept readings are failures only: a gap well past their usual spacing is a stretch it passed, so the line breaks there.
  const gaps = held.slice(1).map((p, i) => p.at - held[i].at).sort((a, b) => a - b);
  const breakAt = Math.max(3600_000, 4 * (gaps[Math.floor(gaps.length / 2)] ?? 0));
  // Every kept reading is drawn; the line only breaks across a gap, so a new reading never hides the ones before it.
  const points = held;
  const zero = trendZero(template, rows, at);
  if (points.length < 2) return null;
  const t0 = points[0].at;
  const t1 = Math.max(now, zero && zero - now < 30 * 24 * 3600_000 ? zero : now);
  const hi = Math.max(line ?? 0, ...points.map((p) => p.v)) * 1.08 || 1;
  const W = 600;
  const H = 72;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - (Math.max(0, v) / hi) * H;
  const last = points[points.length - 1];
  const path = points.map((p, i) => `${i === 0 || p.at - points[i - 1].at > breakAt ? "M" : "L"}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // An episode inside the last day starts at its hour, so its left edge never reads as a date it did not cover.
  const fmtStart = (t: number) => (now - t < 24 * 3600_000 ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" }) : fmtDay(t));
  return (
    <div className="iss-trend">
      <div className="iss-trend-head ops-num">
        {template.cols.length > 1 ? (
          <span className="ops-seg iss-trend-pick" role="group" aria-label="Charted field">
            {template.cols.map((c, i) => <button key={c.label} type="button" data-on={i === at ? "true" : undefined} aria-pressed={i === at} onClick={() => setPicked(i)}>{c.label}</button>)}
          </span>
        ) : <span className="ops-dim">{col.label}</span>}
        <b>{figure(last.v, col)}</b>
        {line !== null && <span className="iss-trend-key"><i />{figure(line, col)}</span>}
        {zero !== null && <span className="iss-trend-zero" title={new Date(zero).toLocaleString()}>{figure(0, col)} {zero - now < 24 * 3600_000 ? `in ${Math.max(1, Math.round((zero - now) / 3600_000))}h` : `by ${fmtDay(zero)}`}</span>}
      </div>
      <svg className="iss-trend-plot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${col.label} over the kept readings`}>
        {line !== null && <line x1={0} x2={W} y1={y(line)} y2={y(line)} className="iss-trend-line" vectorEffect="non-scaling-stroke" />}
        <path d={path} className="iss-trend-path" vectorEffect="non-scaling-stroke" />
        <path d={points.map((p) => `M${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}l0,0`).join("")} className="iss-trend-dots" vectorEffect="non-scaling-stroke" />
        {zero !== null && zero - now < 30 * 24 * 3600_000 && <line x1={x(last.at)} y1={y(last.v)} x2={x(zero)} y2={H} className="iss-trend-proj" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="iss-trend-x ops-num"><span>{fmtStart(t0)}</span><span>{zero !== null && zero > now && zero - now < 30 * 24 * 3600_000 ? fmtDay(zero) : "now"}</span></div>
    </div>
  );
}

/** An app check, run again now, and the watch that runs it in Apps. */
function AppCheckActions({ source }: { source: OpsSource }) {
  useSyncOpsApp(source._id);
  const app = useOpsApp(source._id);
  const keys = useMemo(() => {
    if (!app?.manifest_json) return [];
    try {
      const parsed = parseAppManifest(JSON.parse(app.manifest_json));
      return parsed.ok ? parsed.manifest.watches.filter((w) => w.kind === "check").map(watchKey) : [];
    } catch {
      return [];
    }
  }, [app?.manifest_json]);
  return (
    <span className="ml-auto inline-flex items-center gap-1.5 font-normal">
      {keys.length > 0 && (
        <button
          type="button"
          className="ops-btn iss-contrib-fix"
          onClick={() => {
            for (const k of keys) useInboxStore.getState().pollOpsAppWatch(source._id, k);
            toast(`Running ${source.name}'s ${keys.length === 1 ? "check" : `${keys.length} checks`} now`);
          }}
          title={`Run ${keys.join(", ")} now`}
          data-ops-run-check
        >
          <RotateCcw className="w-3 h-3" /> Run now
        </button>
      )}
      <Link href={opsHref.tab("apps", { app: source.name })} className="ops-btn iss-contrib-fix" title={`${source.name}'s watches in Apps`}>In Apps</Link>
    </span>
  );
}

/** A read's time of day: the breakdown and the watch's own last value each say when they were read, so two counts a minute apart read as two reads. */
const clockTime = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function ShaRef({ sha, href }: { sha: string; href: string | null }) {
  return href ? <Link href={href} className="ops-mono hover:underline">{sha.slice(0, 7)}</Link> : <span className="ops-mono">{sha.slice(0, 7)}</span>;
}

/**
 * What drives a metric alert. A HogQL count watch is split by its own source
 * into what it counted (useMetricBreakdown), each part with its share of the
 * value and the issue that names it. The alert's own source's error groups
 * that fired in the last day rank under it with their shares; other sources'
 * errors in the same window follow as context, with no share, since the
 * metric did not count them.
 */
export function ContributorsCard({ group, watch, now, split, parts, onFixPart }: {
  group: OpsGroup;
  watch?: OpsWatch | null;
  now: number;
  /** The page's own read of what the metric counted (useMetricBreakdown), and its rows: the Fix card leads with the same answer. */
  split: MetricBreakdown;
  parts: BreakdownRow[];
  /** Start a fix on a part no issue names, seeded with its message. */
  onFixPart: (part: BreakdownRow) => void;
}) {
  const groups = useOpsGroups();
  const sources = useOpsSources();
  const since = lastDayStart(now);
  const { rows, total, others } = useMemo(() => metricContributors(group, groups, since, now), [group, groups, since, now]);
  const sourceOf = (id: string) => sources.find((s) => s._id === id);
  const own = sourceOf(group.source_id);
  const [fixFor, setFixFor] = useState<OpsGroup | null>(null);
  // Leave a part out of the metric: the watch's own query, with that part compared away; Undo puts the query back.
  const exclude = (part: BreakdownRow) => {
    if (watch) leaveOutOfWatch(watch, part.key);
  };
  if (!rows.length && !others.length && split.state === "none") return null;
  const counted = parts.reduce((a, p) => a + p.n, 0);
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <span>{parts.length || split.state === "reading" ? "What it counted" : "Errors behind it"} {parts.length > 0 && <span className="ops-dim ops-num">{parts.length}</span>}</span>
        {parts.length > 0 ? (
          <span className="ops-dim font-normal text-meta ops-num">{counted.toLocaleString()} events · {own?.name ?? "its source"} · <span title={new Date(split.state === "rows" ? split.at : now).toLocaleString()}>read {clockTime(split.state === "rows" ? split.at : now)}</span></span>
        ) : rows.length > 0 ? (
          <span className="ops-dim font-normal text-meta ops-num">{total.toLocaleString()} events · last 24h</span>
        ) : null}
      </div>
      {split.state === "reading" && <div className="iss-contrib-note ops-dim">Reading {own?.name ?? "the source"}…</div>}
      {parts.length > 0 && (
        <ol className="iss-contrib" role="list">
          {parts.map((p) => (
            <BreakdownItem key={p.key} part={p} onFix={() => (p.group ? setFixFor(p.group) : onFixPart(p))} onExclude={watch && hogqlExclude(watch.query, p.key) ? () => exclude(p) : undefined} />
          ))}
        </ol>
      )}
      {rows.length > 0 && (
        <>
          {parts.length > 0 && <div className="iss-contrib-sub">Errors on {own?.name ?? "its source"} · last 24h</div>}
          <ol className="iss-contrib" role="list">
            {rows.map((c) => (
              <ContributorRow key={c.group._id} c={c} now={now} onFix={() => setFixFor(c.group)} />
            ))}
          </ol>
        </>
      )}
      {others.length > 0 && (
        <>
          <div className="iss-contrib-sub">Same window, other sources</div>
          <ol className="iss-contrib" role="list" data-context="true">
            {others.map((c) => (
              <ContributorRow key={c.group._id} c={c} now={now} source={sourceOf(c.group.source_id)} onFix={() => setFixFor(c.group)} />
            ))}
          </ol>
        </>
      )}
      {fixFor && <FixReview groups={[fixFor]} source={sourceOf(fixFor.source_id)} onClose={() => setFixFor(null)} />}
    </div>
  );
}

/**
 * One part of the metric's value: what it was, how many, its share, and the
 * issue that names it (else a search for one). Its fix starts seeded with its
 * message, and it can be left out of the metric when it is noise.
 */
function BreakdownItem({ part, onFix, onExclude }: { part: BreakdownRow; onFix: () => void; onExclude?: () => void }) {
  const ref = part.group ? part.group.short_id || part.group._id : null;
  // Known noise (a browser warning, an extension, a stale chunk after a deploy): leaving it out is the cure, a fix session is the second choice.
  const noise = noiseOf(part.key);
  return (
    <li className="iss-contrib-row" data-noise={noise ? "true" : undefined}>
      <span className="iss-contrib-share" aria-hidden><i style={{ width: `${Math.max(2, Math.round(part.share * 100))}%` }} /></span>
      <Link href={ref ? opsHref.issue(ref) : causeSearchHref(part.key)} className="iss-contrib-title" title={ref ? part.key : `Find issues about: ${part.key}`}>{part.key}</Link>
      <span className="iss-contrib-meta ops-num">
        {noise && <span className="iss-noise-tag">{noise}</span>}
        {ref ? <span className="ops-mono ops-dim">{ref}</span> : <span className="ops-dim">no issue</span>}
        <span><b>{part.n.toLocaleString()}</b> <span className="ops-dim">{Math.round(part.share * 100)}%</span></span>
        {onExclude && <button type="button" className="ops-btn iss-contrib-fix" data-tone={noise ? "primary" : undefined} onClick={onExclude} title="Change the watch's query so it stops counting this; Undo puts it back"><EyeOff className="w-3 h-3" /> Leave out</button>}
        <button type="button" className="ops-btn iss-contrib-fix" onClick={onFix} title={ref ? `Start a fix on ${ref}` : "Start a fix seeded with this message"}><Wand2 className="w-3 h-3" /> Start fix</button>
      </span>
    </li>
  );
}

/**
 * A job's failures split by what each said: one job name holds many causes,
 * so each gets its count, share and last time, filters the samples to its own
 * on a press, and starts its own fix. Counted from the server's tally, else
 * from the kept samples, and the head says which.
 */
export function FailureSplitCard({ split, now, picked, onPick, onFix }: { split: FailureSplit; now: number; picked: string | null; onPick: (key: string | null) => void; onFix: (part: FailurePart) => void }) {
  const kept = split.from === "kept";
  return (
    <div className="ops-card" data-ops-failure-split>
      <div className="ops-card-head">
        <span>What failed <span className="ops-dim ops-num">{split.rows.length}</span></span>
        <span className="ops-dim font-normal text-meta ops-num" title={split.since !== null ? `${kept ? "the kept samples" : "every failure"} since ${new Date(split.since).toLocaleString()}` : undefined}>
          {split.total.toLocaleString()} {kept ? "kept runs" : "runs"}{split.since !== null ? ` · since ${relTimeShort(split.since, now)} ago` : ""}
        </span>
      </div>
      <ol className="iss-contrib" role="list">
        {split.rows.map((p) => {
          const on = picked === p.key;
          return (
            <li key={p.key} className="iss-contrib-row" data-on={on ? "true" : undefined}>
              <span className="iss-contrib-share" aria-hidden><i style={{ width: `${Math.max(2, Math.round(p.share * 100))}%` }} /></span>
              <button type="button" className="iss-contrib-title text-left" aria-pressed={on} onClick={() => onPick(on ? null : p.key)} title={on ? "Show every sample" : `Show the samples that said: ${p.key}`}>{p.label}</button>
              <span className="iss-contrib-meta ops-num">
                <span><b>{p.n.toLocaleString()}</b> <span className="ops-dim">{Math.round(p.share * 100)}%</span></span>
                <span className="ops-dim" title={new Date(p.last).toLocaleString()}>{relTimeShort(p.last, now)}</span>
                <button type="button" className="ops-btn iss-contrib-fix" onClick={() => onFix(p)} title="Start a fix on this failure alone"><Wand2 className="w-3 h-3" /> Start fix</button>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ContributorRow({ c, now, source, onFix }: { c: Contributor; now: number; source?: ReturnType<typeof useOpsSources>[number]; onFix: () => void }) {
  const task = useProblemTask(c.group.signal_task_id);
  const stage = taskFixStage(c.group, task ?? undefined);
  const ref = c.group.short_id || c.group._id;
  return (
    <li className="iss-contrib-row">
      {!source && <span className="iss-contrib-share" aria-hidden><i style={{ width: `${Math.max(2, Math.round(c.share * 100))}%` }} /></span>}
      <Link href={opsHref.issue(ref)} className="iss-contrib-title" title={c.group.title}>{c.group.title}</Link>
      <span className="iss-contrib-meta ops-num">
        <span className="ops-mono ops-dim">{ref}</span>
        {source && <SourceChip source={source} />}
        <span><b>{c.n.toLocaleString()}{c.exact ? "" : "+"}</b>{!source && <span className="ops-dim"> {Math.round(c.share * 100)}%</span>}</span>
        <span className="ops-dim">{relTimeShort(c.group.last_seen, now)}</span>
        {stage === "dropped" ? (
          <Link href={`${opsHref.issue(ref)}#iss-fix`} className="iss-fix-open" title="Open the dropped task, or refile it" data-ops-fix-dropped><FixStageGlyph stage={stage} word /></Link>
        ) : <FixStageGlyph stage={stage} word />}
        {stage !== "fixing" && <button type="button" className="ops-btn iss-contrib-fix" onClick={onFix} title={`Start a fix on ${ref}`}><Wand2 className="w-3 h-3" /> {stageFixLabel(c.group, stage, task)}</button>}
      </span>
    </li>
  );
}
