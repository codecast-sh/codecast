"use client";
// Signals (doc "Signals to shipped: one pipeline"): every source of the
// workspace's problems in one table, grouped by kind. A row says whether the
// source is flowing, when it last spoke, its last fourteen days, today against
// a normal day, where its problems go and how they stand. A source that files
// nowhere, or whose problems run off the live flow, says so in its row. A row
// opens the source: an event source its issues (or metrics) narrowed to it, a
// judge the review stages over this page, a finder its findings.
// The source views (Issues, Replays, Metrics, Apps and the events timeline)
// open here too, under `sig` (opsPaths).
import { lazy, memo, Suspense, useMemo, type ComponentType, type MouseEvent } from "react";
import Link from "next/link";
import { ChevronLeft, History, Settings2 } from "lucide-react";
import type { FlowMapLane, FlowMapSource } from "@codecast/shared/contracts/flowMap";
import { useFlowMapRow } from "../../../../../hooks/useFlowMap";
import { useOpsSources, useSyncOpsSources } from "../../../../../hooks/useSyncOps";
import { OUTCOME_LABELS, OUTCOME_ORDER, SIGNAL_GROUPS, routeWords, signalCounts, signalRowState, sinceWords } from "../../../../../lib/line/pipeline";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { opsViewOf, type OpsTab, type OpsView } from "../../../../ops/opsPaths";
import { OpsShell } from "../../../../ops/OpsShell";
import { SETUP_HREF } from "../../../../ops/parts";
import { ageShort } from "../../../../../lib/lineFlow";
import type { LineViewProps } from "../types";
import "./signals.css";

type OpsSourceRow = { _id: string; name: string };

export function SignalsView(props: LineViewProps) {
  const { selection } = props;
  const view = useMemo(() => opsViewOf(selection), [selection]);
  // The source views and the row targets name a source by its name: the sources are fed wherever Signals is open.
  useSyncOpsSources();
  return view ? <SourceView {...props} view={view} /> : <SignalsList {...props} />;
}

// ── the list ───────────────────────────────────────────────────────────────

/** Where a row goes: an event source's issues (its metrics for a watch), a judge's review stages, a finder's findings. */
function opensOf(s: FlowMapSource, ops: ReadonlyMap<string, OpsSourceRow>): LineSelectionPatch | null {
  const src = s.opens.eventSourceId ? ops.get(s.opens.eventSourceId) : undefined;
  if (src) return { view: "signals", sig: s.opens.metricWatchIds ? "metrics" : "issues", source: src.name, app: null, item: null, t: null, stage: null };
  if (s.opens.judgeIds?.length) return { view: "signals", stage: "judges", item: s.key.startsWith("judge:") ? s.key.slice(6) : null, sig: null };
  if (s.opens.finderId) return { view: "line", source: s.key, step: null, finding: null };
  return null;
}

const SignalsList = memo(function SignalsList({ space, select, href, workspace }: LineViewProps) {
  const map = useFlowMapRow(space);
  const opsRows = useOpsSources();
  const ops = useMemo(() => new Map(opsRows.map((o) => [o._id, o])), [opsRows]);
  const counts = useMemo(() => signalCounts(map?.sources ?? []), [map]);
  if (!map) return <div className="lw-empty" data-signals-empty><b>No sources counted yet</b><Link className="lw-link" href={SETUP_HREF}>Connect a source</Link></div>;
  const now = workspace.now;
  return (
    <div className="sg" data-signals={map.sources.length}>
      <header className="sg-bar">
        <span className="sg-counts">
          <Count n={counts.flowing} tone="ok" words="flowing" />
          <Count n={counts.quiet} tone="calm" words="quiet" />
          <Count n={counts.stopped} tone="bad" words="stopped" />
          <Count n={counts.off} tone="warn" words="off the flow" />
          <Count n={counts.unfiled} tone="bad" words="not filed" />
        </span>
        <span className="sg-legend" aria-label="Problem outcomes">
          {OUTCOME_ORDER.map((k) => <span key={k}><i data-o={k} aria-hidden />{OUTCOME_LABELS[k]}</span>)}
        </span>
        <span className="sg-bar-r">
          {map.rolledAt ? <span className="sg-dim" title={new Date(map.rolledAt).toLocaleString()}>counted {ageShort(now - map.rolledAt)} ago</span> : null}
          <Link className="lw-chip" href={href({ view: "timeline", source: null, kind: null, show: null, item: null })} data-signals-timeline><History className="w-3.5 h-3.5" aria-hidden />Timeline</Link>
          <Link className="lw-iconbtn" href={SETUP_HREF} aria-label="Sources" title="Connect and set up sources"><Settings2 className="w-4 h-4" /></Link>
        </span>
      </header>
      <table className="sg-table">
        <colgroup><col data-c="dot" /><col data-c="name" /><col data-c="last" /><col data-c="days" /><col data-c="today" /><col data-c="goes" /><col data-c="out" /></colgroup>
        <thead>
          <tr>
            <th aria-label="State" /><th scope="col">Source</th><th scope="col" data-num="">Last</th><th scope="col">14 days</th><th scope="col" data-num="">Today</th><th scope="col">Goes to</th><th scope="col">Its problems, 30 days</th>
          </tr>
        </thead>
        {SIGNAL_GROUPS.map((g) => {
          const rows = map.sources.filter((s) => s.group === g.key);
          if (!rows.length) return null;
          return (
            <tbody key={g.key} data-signals-group={g.key}>
              <tr className="sg-group"><th colSpan={7} scope="rowgroup">{g.label}<span className="lw-num">{rows.length}</span></th></tr>
              {rows.map((s) => <SourceRow key={s.key} s={s} lanes={map.lanes} now={now} to={opensOf(s, ops)} select={select} href={href} />)}
            </tbody>
          );
        })}
      </table>
    </div>
  );
});

function Count({ n, tone, words }: { n: number; tone: string; words: string }) {
  if (!n && tone !== "ok") return null;
  return <span className="sg-count" data-tone={tone}><i aria-hidden /><b className="lw-num">{n}</b> {words}</span>;
}

function SourceRow({ s, lanes, now, to, select, href }: { s: FlowMapSource; lanes: FlowMapLane[]; now: number; to: LineSelectionPatch | null; select: LineViewProps["select"]; href: LineViewProps["href"] }) {
  const state = signalRowState(s);
  const route = routeWords(s.route, lanes);
  const spike = s.normal > 0 && s.today >= 3 * s.normal && s.today >= 10;
  const open = (e: MouseEvent) => {
    if (!to || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || (e.target as Element).closest("a")) return;
    select(to);
  };
  return (
    <tr className="sg-row" data-state={state} data-opens={to ? "" : undefined} onClick={open} data-signal-source={s.key}>
      <td><i className="sg-dot" data-state={state} title={state === "unfiled" ? "files no problems" : state} /></td>
      <th scope="row" className="sg-name">
        {to ? <a href={href(to)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(to); }}>{s.label}</a> : <span>{s.label}</span>}
        <small>{s.what}</small>
      </th>
      <td data-num="" className="sg-last" data-stale={state === "quiet" || state === "stopped" ? "" : undefined}>{sinceWords(s.lastAt, now)}</td>
      <td><Spark days={s.days} /></td>
      <td data-num="" className="sg-today" data-spike={spike ? "" : undefined}><b className="lw-num">{s.today.toLocaleString()}</b><small>normal {s.normal.toLocaleString()}</small></td>
      <td className="sg-goes" data-route={route.tone}>
        <b>{route.label}</b>
        {s.escapes > 0 && <small data-tone="warn">{s.escapes.toLocaleString()} ran off the flow</small>}
        {s.unfiled > 0 && <small data-tone="bad">{s.unfiled.toLocaleString()} never filed</small>}
      </td>
      <td><Outcomes s={s} /></td>
    </tr>
  );
}

/** Fourteen days as bars, today's last and lit; a day with nothing is a tick on the floor. */
function Spark({ days }: { days: number[] }) {
  const max = Math.max(1, ...days);
  const W = 6, G = 2, H = 22;
  return (
    <svg className="sg-spark" width={days.length * (W + G) - G} height={H} viewBox={`0 0 ${days.length * (W + G) - G} ${H}`} aria-label={`last 14 days: ${days.join(", ")}`}>
      {days.map((d, i) => {
        const h = d ? Math.max(2, Math.round((d / max) * H)) : 1;
        return <rect key={i} x={i * (W + G)} y={H - h} width={W} height={h} rx={1} data-today={i === days.length - 1 ? "" : undefined} data-zero={d ? undefined : ""}><title>{d.toLocaleString()}</title></rect>;
      })}
    </svg>
  );
}

/** A source's problems by where they stand, one bar, with the total under it. */
function Outcomes({ s }: { s: FlowMapSource }) {
  const o = s.outcomes;
  if (!o.total) return <span className="sg-dim">none</span>;
  return (
    <span className="sg-out">
      <span className="sg-out-bar">
        {OUTCOME_ORDER.map((k) => (o[k] ? <i key={k} data-o={k} style={{ flexGrow: o[k] }} title={`${o[k].toLocaleString()} ${OUTCOME_LABELS[k]}`} /> : null))}
      </span>
      <small className="lw-num">{o.total.toLocaleString()}</small>
    </span>
  );
}

// ── a source open ──────────────────────────────────────────────────────────

type TabPage = ComponentType<{ source: string | null; app: string | null }>;
const TABS: Record<OpsTab, TabPage> = {
  timeline: lazy(() => import("../../../../ops/TimelineTab").then((m) => ({ default: m.TimelineTab }))),
  issues: lazy(() => import("../../../../ops/IssuesTab").then((m) => ({ default: m.IssuesTab }))),
  replays: lazy(() => import("../../../../ops/ReplaysTab").then((m) => ({ default: m.ReplaysTab }))),
  metrics: lazy(() => import("../../../../ops/MetricsTab").then((m) => ({ default: m.MetricsTab }))),
  apps: lazy(() => import("../../../../ops/AppsTab").then((m) => ({ default: m.AppsTab }))),
};
const IssuePage = lazy(() => import("../../../../ops/IssuePage").then((m) => ({ default: m.IssuePage })));
const ReplayPage = lazy(() => import("../../../../ops/ReplayPage").then((m) => ({ default: m.ReplayPage })));

function OpsPage({ view }: { view: OpsView }) {
  if (view.view === "issue") return <IssuePage id={view.id} />;
  if (view.view === "replay") return <ReplayPage id={view.id} t={view.t} />;
  if (view.view === "tab") {
    const Tab = TABS[view.tab];
    return <Tab source={view.source} app={view.app} />;
  }
  return null;
}

/** A source view: Signals' way back and the source's name, then its Ops tabs. A source is named by its name; a
 *  reference opens it by `src-N` or its row id, which read as the name they stand for. */
function SourceView({ view: asked, space, href, select }: LineViewProps & { view: OpsView }) {
  const sources = useOpsSources() as Array<OpsSourceRow & { short_id?: string }>;
  const map = useFlowMapRow(space);
  const view = useMemo<OpsView>(() => {
    if (asked.view !== "tab" || !asked.source) return asked;
    const named = sources.find((s) => s.short_id === asked.source || s._id === asked.source);
    return named ? { ...asked, source: named.name } : asked;
  }, [asked, sources]);
  const name = view.view === "tab" ? view.source : null;
  // The source's own words from the map, where a row of it opened this view.
  const label = useMemo(() => {
    if (!name) return null;
    const src = sources.find((s) => s.name === name);
    return (src && map?.sources.find((r) => r.opens.eventSourceId === src._id && !r.key.split(":")[2])?.label) ?? name;
  }, [name, sources, map]);
  const home: LineSelectionPatch = { view: "signals", sig: null, source: null, app: null, item: null, t: null };
  const lead = (
    <>
      <a className="sg-crumb" href={href(home)} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(home); }} data-signals-back><ChevronLeft className="w-4 h-4" aria-hidden />Signals</a>
      {label ? <><span className="sg-crumb-sep" aria-hidden>/</span><span>{label}</span></> : null}
    </>
  );
  return (
    <div className="sg-source" data-signals-source={name ?? view.view}>
      <OpsShell view={view} lead={lead}>
        <Suspense fallback={null}><OpsPage view={view} /></Suspense>
      </OpsShell>
    </div>
  );
}
