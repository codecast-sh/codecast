"use client";
// Signals (doc "Signals to shipped: one pipeline"): every source of the
// workspace's problems in one table, grouped by kind. A row says whether the
// source is flowing, when it last spoke, its last fourteen days, today against
// a normal day, where its problems go and how they stand. A source that files
// nowhere, or whose problems run off the live flow, says so in its row. A row
// opens the source: an event source its issues (or metrics) narrowed to it, a
// judge the review stages over this page, a finder its findings.
// An event source's row opens it in Ops (/ops); an older source-view address
// here (`sig`, opsPaths) goes there too. Ops reads the app's active workspace:
// a row from another workspace opens Ops' own not-found page for the source,
// whose Switch button is the one deliberate way to change workspace.
import { memo, useMemo, type MouseEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { History, Radar, Settings2 } from "lucide-react";
import type { FlowMapLane, FlowMapSource } from "@codecast/shared/contracts/flowMap";
import { useFlowMapRow } from "../../../../../hooks/useFlowMap";
import { useOpsSources, useSyncOpsSources } from "../../../../../hooks/useSyncOps";
import { OUTCOME_LABELS, OUTCOME_ORDER, SIGNAL_GROUPS, routeWords, signalCounts, signalRowState, sinceWords } from "../../../../../lib/line/pipeline";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { opsHref, opsViewHref, opsViewOf } from "../../../../ops/opsPaths";
import { SETUP_HREF } from "../../../../ops/parts";
import { useSourceHealthMap } from "../../../../ops/useSourceHealth";
import { useOpsAttention } from "../../../../ops/useOpsAttention";
import { opsBadge } from "../../../../ops/opsHomeModel";
import { HealthBadge, HealthFixButton } from "../../../../ops/SourceHealthParts";
import type { SourceHealth } from "../../../../ops/sourceHealth";
import type { OpsSource } from "../../../../ops/opsTypes";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { useActiveWorkspaceKey } from "../../../../../hooks/useWorkspaceCollection";
import { useInboxStore } from "../../../../../store/inboxStore";
import { activeWorkspaceKeyOf } from "../../../../../lib/workspaceScope";
import { ageShort } from "../../../../../lib/lineFlow";
import type { LineViewProps } from "../types";
import "./signals.css";

type OpsSourceRow = { _id: string; name: string };

export function SignalsView(props: LineViewProps) {
  const { selection } = props;
  const view = useMemo(() => opsViewOf(selection), [selection]);
  // The source views and the row targets name a source by its name: the sources are fed wherever Signals is open.
  useSyncOpsSources();
  const router = useRouter();
  const to = view ? opsViewHref(view) : null;
  useWatchEffect(() => { if (to) router.replace(to); }, [router, to]);
  return to ? null : <SignalsList {...props} />;
}

/**
 * Open an Ops address from this list. It never switches the app's workspace,
 * which every window and the CLI share: a source from another workspace than
 * the active one lands on Ops' "is in <workspace>" page, which asks.
 */
function useOpenInOps() {
  const router = useRouter();
  return (href: string) => router.push(href);
}

// ── the list ───────────────────────────────────────────────────────────────

/** Where a row goes: an event source's issues in Ops (its metrics for a watch), a judge's review stages, a finder's findings. */
function opensOf(s: FlowMapSource, ops: ReadonlyMap<string, OpsSourceRow>): LineSelectionPatch | string | null {
  const src = s.opens.eventSourceId ? ops.get(s.opens.eventSourceId) : undefined;
  if (src) return opsHref.tab(s.opens.metricWatchIds ? "metrics" : "issues", { source: src.name });
  if (s.opens.judgeIds?.length) return { view: "signals", stage: "judges", item: s.key.startsWith("judge:") ? s.key.slice(6) : null, sig: null };
  if (s.opens.finderId) return { view: "line", source: s.key, step: null, finding: null };
  return null;
}

const SignalsList = memo(function SignalsList({ space, select, href, workspace }: LineViewProps) {
  const map = useFlowMapRow(space);
  const opsRows = useOpsSources();
  const ops = useMemo(() => new Map(opsRows.map((o) => [o._id, o])), [opsRows]);
  const counts = useMemo(() => signalCounts(map?.sources ?? []), [map]);
  const openOps = useOpenInOps();
  // The one health reading per event source (ops/sourceHealth.ts): a row whose source needs a fix says so with the fix.
  const health = useSourceHealthMap();
  if (!map || !map.sources.length) return <div className="lw-empty" data-signals-empty><b>No sources counted yet</b><Link className="lw-link" href={SETUP_HREF}>Connect a source</Link></div>;
  const now = workspace.now;
  return (
    <div className="sg" data-signals={map.sources.length}>
      <header className="sg-bar">
        <span className="sg-counts">
          <Count n={counts.flowing} tone="ok" words="flowing" />
          <Count n={counts.quiet} tone="calm" words="quiet" />
          <Count n={counts.stopped} tone="bad" words="silent" />
          <Count n={counts.off} tone="warn" words="off the flow" />
          <Count n={counts.unfiled} tone="bad" words="not filed" />
        </span>
        <span className="sg-legend" aria-label="Problem outcomes">
          {OUTCOME_ORDER.map((k) => <span key={k}><i data-o={k} aria-hidden />{OUTCOME_LABELS[k]}</span>)}
        </span>
        <span className="sg-bar-r">
          {map.rolledAt ? <span className="sg-dim" title={new Date(map.rolledAt).toLocaleString()}>counted {ageShort(now - map.rolledAt)} ago</span> : null}
          <OpsChip />
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
              {rows.map((s) => <SourceRow key={s.key} s={s} lanes={map.lanes} now={now} to={opensOf(s, ops)} select={select} href={href} openOps={openOps} health={s.opens.eventSourceId ? health.get(s.opens.eventSourceId) : undefined} source={s.opens.eventSourceId ? ops.get(s.opens.eventSourceId) : undefined} />)}
            </tbody>
          );
        })}
      </table>
    </div>
  );
});

/**
 * The way to Ops from here, with the count that pages a person there (the
 * sidebar badge's number and words). Ops reads the app's active workspace: a
 * list scoped to another one shows no count, since the page it opens counts
 * something else.
 */
function OpsChip() {
  const health = useSourceHealthMap();
  const items = useOpsAttention(health);
  const { n, words } = useMemo(() => opsBadge(items), [items]);
  const scoped = useActiveWorkspaceKey();
  const active = useInboxStore(activeWorkspaceKeyOf);
  const shown = scoped === active ? n : 0;
  return (
    <Link className="lw-chip" href={opsHref.home()} title={shown ? words : undefined} data-signals-ops={shown}>
      <Radar className="w-3.5 h-3.5" aria-hidden />Ops{shown > 0 ? <b className="lw-num sg-ops-n">{shown}</b> : null}
    </Link>
  );
}

function Count({ n, tone, words }: { n: number; tone: string; words: string }) {
  if (!n) return null;
  return <span className="sg-count" data-tone={tone}><i aria-hidden /><b className="lw-num">{n}</b> {words}</span>;
}

function SourceRow({ s, lanes, now, to, select, href, openOps, health, source }: { s: FlowMapSource; lanes: FlowMapLane[]; now: number; to: LineSelectionPatch | string | null; select: LineViewProps["select"]; href: LineViewProps["href"]; openOps: (href: string) => void; health?: SourceHealth; source?: OpsSource }) {
  const needsFix = !!health && (health.tone === "warn" || (health.tone === "bad" && health.state !== "stopped") || health.state === "paused");
  const state = signalRowState(s);
  const route = routeWords(s.route, lanes);
  const spike = s.normal > 0 && s.today >= 3 * s.normal && s.today >= 10;
  const open = (e: MouseEvent) => {
    if (!to || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || (e.target as Element).closest("a")) return;
    if (typeof to === "string") openOps(to);
    else select(to);
  };
  const toHref = to ? (typeof to === "string" ? to : href(to)) : null;
  // A source's row carries the source's own name, as Ops and its chip write it; a filing row ("… failed jobs") keeps the server's words.
  const label = source && s.label.toLowerCase() === source.name.toLowerCase() ? source.name : s.label;
  return (
    <tr className="sg-row" data-state={state} data-opens={to ? "" : undefined} onClick={open} data-signal-source={s.key}>
      <td><i className="sg-dot" data-state={state} title={state === "unfiled" ? "files no problems" : state} /></td>
      <th scope="row" className="sg-name">
        {to && toHref ? <a href={toHref} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); if (typeof to === "string") openOps(to); else select(to); }}>{label}</a> : <span>{label}</span>}
        <small>{s.what}</small>
        {needsFix && health && source && (
          <span className="sg-health" onClick={(e) => e.stopPropagation()}>
            <HealthBadge health={health} />
            <HealthFixButton source={source} health={health} />
          </span>
        )}
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
