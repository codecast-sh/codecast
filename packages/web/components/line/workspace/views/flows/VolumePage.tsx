"use client";
// The Volume page (view=volume, under the live flow's head): the whole line
// on one screen. Top, what holds work, each block with its count and the
// place to act on it. Then the sources, what arrived against what read it;
// every open problem by where it stands; the window's days (opened, runs
// started, landed, closed clean, today against a normal day); and the funnel
// of the problems opened in the window. Every count opens its problems under
// it. The numbers are the flow map rollup's (lineVolume.ts, lineFunnel.ts),
// read from the store; the window (win) and the open count (show) live in the
// address, so the page and anything opened on it can be sent.
import { useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import type { FlowMap } from "@codecast/shared/contracts/flowMap";
import { normalDay } from "@codecast/shared/contracts/flowMap";
import { FUNNEL_WINDOWS } from "@codecast/shared/contracts/lineFunnel";
import { BACKLOG_BLOCKED, RECORDING, backlogItemsOf, type BacklogStand, type FlowDay } from "@codecast/shared/contracts/lineVolume";
import { ageShort } from "../../../../../lib/lineFlow";
import { STAND_WORDS, coverageKindWords, coverageRows, volumeBlocks, type VolumeBlock, type VolumeLive } from "../../../../../lib/line/volumeBlocks";
import type { LineSelection, LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import { useSyncOrgTreeFeeder } from "../../../../../hooks/useSyncOrgTree";
import { ProjectLeadChip } from "../../../../charter/ProjectLeadChip";
import type { LineViewProps } from "../types";
import { FunnelChart } from "./FlowVolume";
import "./flowVolume.css";
import "./volumePage.css";

type Props = { map: FlowMap; live: VolumeLive; href: LineViewProps["href"]; select: LineViewProps["select"]; selection: LineSelection; now: number };
const fmt = (n: number) => n.toLocaleString();
/** Counts older than this read as stale: the rollup runs hourly. */
const STALE_MS = 3 * 3_600_000;

export function VolumePage({ map, live, href, select, selection, now }: Props) {
  useSyncOrgTreeFeeder();
  const days = selection.win === "30" ? 30 : 7;
  const show = selection.show;
  const toggle = (v: string) => select({ show: show === v ? null : v });
  const go = (patch: LineSelectionPatch) => (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(patch); };
  const age = map.rolledAt != null ? now - map.rolledAt : null;
  const blocks = volumeBlocks(map, live, now, days);
  const ctx = { map, href, select, go, toggle, show, now, days };
  return (
    <div className="vp" data-volume-page={days}>
      <header className="vp-head">
        <h2 className="vp-title">Volume</h2>
        <div className="lw-seg" role="tablist" aria-label="Window">
          {FUNNEL_WINDOWS.map((d) => (
            <button key={d} type="button" role="tab" aria-selected={d === days} onClick={() => select({ win: d === 7 ? null : String(d) })} data-volume-window={d}>{d} days</button>
          ))}
        </div>
        {age != null ? (
          <span className="vp-age" data-tone={age > STALE_MS ? "bad" : undefined} title={new Date(map.rolledAt!).toLocaleString()} data-volume-age>
            counted <span className="lw-num">{ageShort(Math.max(0, age))}</span> ago
          </span>
        ) : <span className="vp-age" data-tone="bad">not counted yet</span>}
      </header>
      <Holding blocks={blocks} {...ctx} />
      <div className="vp-grid">
        <Sources {...ctx} />
        <Backlog {...ctx} />
      </div>
      <Days map={map} days={days} now={now} />
      <FunnelChart map={map} days={days} href={href} select={select} now={now} />
    </div>
  );
}

type Ctx = { map: FlowMap; href: LineViewProps["href"]; select: LineViewProps["select"]; go: (p: LineSelectionPatch) => (e: MouseEvent) => void; toggle: (v: string) => void; show: string | null; now: number; days: number };

// ── what holds work ─────────────────────────────────────────────────────────

/** Each block's Open sets the count open in the address; the list draws in its own section (the backlog, the sources). */
function Holding({ blocks, toggle, show, go, href }: Ctx & { blocks: VolumeBlock[] }) {
  if (!blocks.length) return <section className="vp-hold" data-volume-hold="clear"><span className="vp-clear">Nothing holding work</span></section>;
  return (
    <section className="vp-hold" aria-label="Holding work" data-volume-hold={blocks.length}>
      <ul className="vp-blocks">
        {blocks.map((b) => (
          <li key={b.key} className="vp-block" data-tone={b.tone} data-volume-block={b.key}>
            <b className="vp-block-n lw-num">{b.n}</b>
            <span className="vp-block-label">{b.label}</span>
            <span className="vp-block-act">
              {b.act?.kind === "lead" ? <ProjectLeadChip projectId={b.act.project} editable size="xs" />
                : b.act?.kind === "show" ? <button type="button" className="lw-chip" aria-pressed={show === b.act.show} onClick={() => toggle((b.act as { show: string }).show)}>Open</button>
                : b.act?.kind === "go" ? <a className="lw-chip" href={href(b.act.patch)} onClick={go(b.act.patch)}>Open For you</a>
                : b.act?.kind === "page" ? <Link className="lw-chip" href={b.act.href}>{b.act.label}</Link>
                : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── sources: arrived against read ───────────────────────────────────────────

function Sources(c: Ctx) {
  const { map, now, days, toggle, show, href, go } = c;
  const [all, setAll] = useState(false);
  // A kind with nothing in the window (one retired, or not sent any more) is no row.
  const rows = coverageRows(map, now, days).filter((r) => r.t.arrived > 0);
  const window = map.funnel?.windows.find((w) => w.days === days);
  const findings = [...map.sources].map((s) => ({ s, n: window?.sources.find((x) => x.key === s.key)?.n ?? 0 })).filter((x) => x.n > 0 || x.s.today > 0).sort((a, b) => b.n - a.n);
  const shown = all ? findings : findings.slice(0, 8);
  return (
    <section className="vp-card" aria-label="Sources" data-volume-sources>
      <h3 className="vp-h">Sources <span className="vp-h-n">arrived against read</span></h3>
      <table className="vp-table">
        <thead>
          <tr><th />{["Today", "In", "Read", "Judged", "Failed", "Unread"].map((h) => <th key={h} className="lw-num">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = `src:${r.source_id}:${r.kind}`;
            const judgeable = r.kind !== RECORDING || r.t.judged > 0 || rows.some((x) => x.source_id === r.source_id && x.kind === "replay");
            return (
              <tr key={key} data-volume-source={key} aria-selected={show === key}>
                <th scope="row"><button type="button" className="vp-link" onClick={() => toggle(key)}>{r.label} <span className="vp-dim">{coverageKindWords(r.kind)}</span></button></th>
                <td className="lw-num" title="Arrived today, and how many of them were left unread">{fmt(r.today.arrived)}{r.todayGap > 0 ? <span className="vp-gap"> −{fmt(r.todayGap)}</span> : null}</td>
                <td className="lw-num"><b>{fmt(r.t.arrived)}</b></td>
                <td className="lw-num">{fmt(r.t.read)}</td>
                <td className="lw-num" data-tone={judgeable ? undefined : "bad"}>{judgeable ? fmt(r.t.judged) : "no judge"}</td>
                <td className="lw-num" data-tone={r.t.failed ? "bad" : undefined}>{fmt(r.t.failed)}</td>
                <td className="lw-num" data-tone={r.gap > 0 ? (r.gap > r.t.arrived / 10 ? "bad" : "warn") : "ok"}><b>{fmt(r.gap)}</b></td>
              </tr>
            );
          })}
          {!rows.length ? <tr><td colSpan={7} className="vp-dim">No conversations or recordings in {days} days</td></tr> : null}
        </tbody>
      </table>
      {show?.startsWith("src:") ? <SourceDays {...c} /> : null}
      <h4 className="vp-h4">Findings by source <span className="vp-h-n">today · {days} days</span></h4>
      <ul className="vp-finds">
        {shown.map(({ s, n }) => {
          const patch: LineSelectionPatch = { view: "signals", source: s.key, sig: null, stage: null, item: null };
          return (
            <li key={s.key}>
              <a href={href(patch)} onClick={go(patch)} data-state={s.state}>
                <i aria-hidden className="vp-dot" />
                <span className="vp-find-name">{s.label}</span>
                <span className="lw-num vp-dim">{fmt(s.today)}</span>
                <b className="lw-num">{fmt(n)}</b>
              </a>
            </li>
          );
        })}
      </ul>
      {findings.length > 8 ? <button type="button" className="vp-more" onClick={() => setAll(!all)}>{all ? "Fewer" : `+${findings.length - 8} sources`}</button> : null}
    </section>
  );
}

/** The open source's days: what arrived each day, the part read and judged, failed, and left unread. */
function SourceDays({ map, show, now, days, href, go }: Ctx) {
  const row = coverageRows(map, now, days).find((r) => `src:${r.source_id}:${r.kind}` === show);
  if (!row) return null;
  const list = row.days.slice(-days);
  const max = Math.max(1, ...list.map((d) => d.arrived));
  const src = map.sources.find((s) => s.opens.eventSourceId === row.source_id);
  const patch: LineSelectionPatch = row.kind === RECORDING
    ? { view: "signals", source: src?.key ?? null, sig: "replays", stage: null, item: null }
    : { view: "signals", stage: "moments", item: row.kind };
  return (
    <div className="vp-srcdays" data-volume-source-days={show ?? ""}>
      <div className="vp-srcdays-head"><b>{row.label}</b><span className="vp-dim">{coverageKindWords(row.kind)}</span><a className="lw-chip" href={href(patch)} onClick={go(patch)}>Open {row.kind === RECORDING ? "recordings" : "moments"}</a></div>
      <ol className="vp-bars" style={{ ["--vp-n" as string]: list.length }}>
        {list.map((d) => {
          const judged = row.kind === RECORDING ? 0 : d.judged;
          return (
            <li key={d.day} title={`${d.day}: ${d.arrived} in, ${d.read} read, ${judged} judged, ${d.failed} failed`}>
              <span className="vp-stack" style={{ height: `${(d.arrived / max) * 100}%` }}>
                <i data-part="judged" style={{ flexGrow: judged }} />
                <i data-part="read" style={{ flexGrow: Math.max(0, d.read - judged) }} />
                <i data-part="failed" style={{ flexGrow: d.failed }} />
                <i data-part="unread" style={{ flexGrow: Math.max(0, d.arrived - Math.max(d.read, judged) - d.failed) }} />
              </span>
            </li>
          );
        })}
      </ol>
      <ul className="vp-key"><li data-part="judged"><i />judged</li><li data-part="read"><i />read</li><li data-part="failed"><i />failed</li><li data-part="unread"><i />not read</li></ul>
    </div>
  );
}

// ── the backlog ─────────────────────────────────────────────────────────────

function Backlog(c: Ctx) {
  const { map, show, toggle } = c;
  const b = map.backlog;
  if (!b) return <section className="vp-card" aria-label="Open problems"><h3 className="vp-h">Open problems</h3><p className="vp-dim">Not counted yet</p></section>;
  const projectsOf = (stand: BacklogStand) => b.projects.filter((p) => p.stand === stand).slice(0, 4);
  return (
    <section className="vp-card" aria-label="Open problems" data-volume-backlog={b.total}>
      <h3 className="vp-h">Open problems <b className="lw-num">{fmt(b.total)}</b> <span className="vp-h-n">by where they stand</span></h3>
      <ul className="vp-stands">
        {b.stands.map(({ stand, n }) => {
          const key = `stand:${stand}`;
          const sub = stand === "nolead" || stand === "noproject" || stand === "eligible" ? projectsOf(stand) : [];
          const stations = b.stations.filter((s) => (s.stand ?? "running") === stand);
          return (
            <li key={stand} data-stand={stand} data-blocked={BACKLOG_BLOCKED.has(stand) ? "" : undefined}>
              <button type="button" className="vp-stand" aria-pressed={show === key} onClick={() => toggle(key)} data-volume-stand={stand}>
                <b className="lw-num">{fmt(n)}</b>
                <span className="vp-stand-w">{STAND_WORDS[stand]}</span>
                <span className="vp-stand-bar" aria-hidden><i style={{ width: `${Math.max(0.5, (n / b.total) * 100)}%` }} /></span>
              </button>
              {sub.length > 1 || (sub.length === 1 && stand !== "noproject") ? (
                <ul className="vp-sub">
                  {sub.map((p) => (
                    <li key={p.project ?? "none"}>
                      <button type="button" className="vp-link" aria-pressed={show === `${key}:${p.project}`} onClick={() => toggle(`${key}:${p.project ?? ""}`)}>
                        <span className="lw-num">{fmt(p.n)}</span> {p.project ? map.backlogProjects?.[p.project]?.title ?? "A project" : "no project"}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {stations.length ? <ul className="vp-sub">{stations.slice(0, 4).map((s) => <li key={s.node}><span className="lw-num">{fmt(s.n)}</span> at {s.node}</li>)}</ul> : null}
            </li>
          );
        })}
      </ul>
      {show?.startsWith("stand:") ? <Opened {...c} /> : null}
    </section>
  );
}

/** The problems behind an open backlog count: at most what the rollup kept, with the way to the full list. */
function Opened({ map, show, href, go, now, toggle }: Ctx) {
  const b = map.backlog;
  if (!b || !show?.startsWith("stand:")) return null;
  const [, stand, project] = show.split(":") as [string, BacklogStand, string | undefined];
  const items = backlogItemsOf(b, stand, project === undefined ? undefined : project || null);
  const total = project === undefined ? b.stands.find((s) => s.stand === stand)?.n ?? 0 : b.projects.find((p) => p.stand === stand && (p.project ?? "") === project)?.n ?? 0;
  const ref = project ? map.backlogProjects?.[project]?.ref ?? project : null;
  const full: LineSelectionPatch = { view: "problems", ...(ref ? { project: ref } : {}) };
  return (
    <div className="fv-items" data-volume-items={show}>
      <div className="fv-items-head">
        <b>{STAND_WORDS[stand]}</b>
        {project ? <span className="vp-dim">{map.backlogProjects?.[project]?.title}</span> : null}
        <span className="fv-items-n lw-num">{items.length < total ? `${items.length} of ${fmt(total)}` : fmt(total)}</span>
        {items.length < total ? <a className="lw-chip" href={href(full)} onClick={go(full)}>All in Problems</a> : null}
        <button type="button" className="fv-x" onClick={() => toggle(show)} aria-label="Close">×</button>
      </div>
      <ul className="fv-rows">
        {items.map((x) => {
          const run: LineSelectionPatch | null = x.run ? { view: "problems", run: x.run, case: x.ref ?? x.task } : null;
          return (
            <li key={x.task} className="fv-row">
              <Link className="fv-row-task" href={`/tasks/${x.ref ?? x.task}`}>
                {x.ref ? <span className="fv-ref lw-num">{x.ref}</span> : null}
                <span className="fv-row-title">{x.title}</span>
              </Link>
              {run ? <a className="fv-row-run" href={href(run)} onClick={go(run)} data-status={x.status}><span>{x.node ?? "Run"}</span><span className="fv-status">{x.status}</span></a> : <span className="fv-row-run" data-status="none"><span>No run</span></span>}
              <span className="fv-row-at lw-num">{ageShort(Math.max(0, now - x.at))}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── is it flowing ───────────────────────────────────────────────────────────

const SERIES: Array<{ key: keyof Omit<FlowDay, "day">; label: string }> = [
  { key: "opened", label: "Problems opened" }, { key: "ran", label: "Runs started" }, { key: "landed", label: "Landed" }, { key: "clean", label: "Closed clean" },
];

function Days({ map, days, now }: { map: FlowMap; days: number; now: number }) {
  const list = (map.backlog?.days ?? []).slice(-days);
  if (!list.length) return null;
  return (
    <section className="vp-card vp-days" aria-label="Per day" data-volume-days={days}>
      <h3 className="vp-h">Per day <span className="vp-h-n">today against a normal day</span></h3>
      <div className="vp-series">
        {SERIES.map(({ key, label }) => {
          const vals = list.map((d) => d[key]);
          const today = vals[vals.length - 1];
          const normal = normalDay(vals.slice(0, -1));
          const max = Math.max(1, ...vals);
          // Today is partial: it is judged against the share of a normal day the clock has passed.
          const pace = normal * Math.max(0.05, (now % 86_400_000) / 86_400_000);
          const tone = normal && today < pace / 2 ? "bad" : normal && today < pace ? "warn" : "ok";
          return (
            <Series key={key} label={label} today={today} normal={normal} tone={tone} total={vals.reduce((a, b) => a + b, 0)} days={days}>
              <ol className="vp-bars" style={{ ["--vp-n" as string]: list.length }}>
                {list.map((d, i) => (
                  <li key={d.day} title={`${d.day}: ${d[key]}`} data-today={i === list.length - 1 ? "" : undefined}>
                    <span className="vp-col" style={{ height: `${(d[key] / max) * 100}%` }} />
                  </li>
                ))}
              </ol>
            </Series>
          );
        })}
      </div>
    </section>
  );
}

function Series({ label, today, normal, tone, total, days, children }: { label: string; today: number; normal: number; tone: string; total: number; days: number; children: ReactNode }) {
  return (
    <div className="vp-s" data-series={label}>
      <div className="vp-s-head">
        <span className="vp-s-name">{label}</span>
        <b className="lw-num vp-s-today" data-tone={tone} title="Today so far (UTC)">{fmt(today)}</b>
        <span className="vp-dim lw-num" title="The median day with any">normal {fmt(normal)}</span>
        <span className="vp-dim lw-num">{fmt(total)} in {days}d</span>
      </div>
      {children}
    </div>
  );
}
