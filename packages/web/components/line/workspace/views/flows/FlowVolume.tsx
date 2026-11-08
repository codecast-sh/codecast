"use client";
// The Flows page's Volume view: everything that moved through the line in a
// window, as one chart. Left to right the signals that came in, the problems
// opened, the runs started, each station of the live flow, then merged, live
// and closed clean. Each column's bar is the problems that reached it; the
// part that went no further is split by why, colored. Every count and every
// drop opens its items under the chart: the problem (its task page) and where
// its run stands (the run). The numbers are the flow map rollup's
// (shared/contracts/lineFunnel.ts), read from the store.
import { useState, type MouseEvent } from "react";
import Link from "next/link";
import type { FlowMap } from "@codecast/shared/contracts/flowMap";
import { FUNNEL_REASONS, FUNNEL_WINDOWS, funnelItemsOf, type FunnelReason, type FunnelWindow } from "@codecast/shared/contracts/lineFunnel";
import { ageShort } from "../../../../../lib/lineFlow";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import type { LineViewProps } from "../types";
import "./flowVolume.css";

const REASON_WORDS: Record<FunnelReason, string> = {
  closed: "closed, no fix", dropped: "dropped", failed: "failed", cancelled: "cancelled", regressed: "came back", other: "other",
  here: "here now", waiting: "on a person", unstarted: "not started", held: "held back", watching: "watching",
};

/** What the list under the chart shows: the signals by source, everyone who reached a step, or those who stopped there for one reason. */
type Pick = { kind: "signals" } | { kind: "step"; level: number; why?: FunnelReason } | null;

const same = (a: Pick, b: Pick) => JSON.stringify(a) === JSON.stringify(b);

export function FlowVolume({ map, href, select, now }: { map: FlowMap; href: LineViewProps["href"]; select: LineViewProps["select"]; now: number }) {
  const [days, setDays] = useState<number>(FUNNEL_WINDOWS[0]);
  const [pick, setPick] = useState<Pick>(null);
  const toggle = (p: Pick) => setPick((cur) => (same(cur, p) ? null : p));
  const f = map.funnel;
  if (!f) return <section className="fv" data-flow-volume=""><p className="fv-none">No rollup yet</p></section>;
  const w = f.windows.find((x) => x.days === days) ?? f.windows[0];
  // Signals and problems each fill their own column (thousands of findings, most problems never started); from the
  // runs on, every bar and share is against the runs started.
  const runs = Math.max(1, w.steps[1]?.n ?? 0);
  const label = new Map(map.sources.map((s) => [s.key, s.label]));

  return (
    <section className="fv" aria-label="Volume" data-flow-volume={days}>
      <header className="fv-head">
        <h2 className="fv-title">Volume</h2>
        <div className="lw-seg" role="tablist" aria-label="Window">
          {FUNNEL_WINDOWS.map((d) => (
            <button key={d} type="button" role="tab" aria-selected={d === days} onClick={() => { setDays(d); }} data-flow-volume-window={d}>{d} days</button>
          ))}
        </div>
        <span className="fv-age" title={new Date(f.at).toLocaleString()}>as of <span className="lw-num">{ageShort(Math.max(0, now - f.at))}</span> ago</span>
      </header>

      <ol className="fv-chart" style={{ ["--fv-n" as string]: w.steps.length + 1 }}>
        {/* The signals: their own scale, many findings to a problem. */}
        <li className="fv-col" data-step="signals">
          <span className="fv-name">Signals in</span>
          <button type="button" className="fv-count" aria-pressed={pick?.kind === "signals"} onClick={() => toggle({ kind: "signals" })} data-flow-volume-count="signals">
            <b className="lw-num">{w.signals.toLocaleString()}</b>
          </button>
          <span className="fv-track"><span className="fv-bar" data-signals="" style={{ ["--f" as string]: w.signals ? 1 : 0 }} /></span>
          <ul className="fv-drops">
            {w.sources.slice(0, 3).map((s) => <li key={s.key} className="fv-src"><span>{label.get(s.key) ?? s.key}</span><b className="lw-num">{s.n.toLocaleString()}</b></li>)}
            {w.sources.length > 3 ? <li className="fv-src" data-more=""><button type="button" onClick={() => setPick({ kind: "signals" })}>+{w.sources.length - 3} sources</button></li> : null}
          </ul>
        </li>
        {w.steps.map((s, i) => {
          // The ones that went on to the next step; at the last, all of them made it.
          const on = i === w.steps.length - 1 ? s.n : w.steps[i + 1].n;
          const reasons = FUNNEL_REASONS.filter((r) => s.drops[r]);
          const share = s.n && i > 1 ? Math.round((s.n / runs) * 100) : null;
          return (
            <li key={s.key} className="fv-col" data-step={s.key} data-own={i === 0 ? "" : undefined}>
              <span className="fv-name">{s.label}</span>
              <button type="button" className="fv-count" aria-pressed={same(pick, { kind: "step", level: i })} disabled={!s.n} onClick={() => toggle({ kind: "step", level: i })} data-flow-volume-count={s.key}>
                <b className="lw-num">{s.n.toLocaleString()}</b>
                {share != null ? <span className="fv-share lw-num">{share}%</span> : null}
              </button>
              <span className="fv-track">
                <span className="fv-bar" style={{ ["--f" as string]: i === 0 ? (s.n ? 1 : 0) : s.n / runs }}>
                  {/* The ones that went on, then the ones that stopped here, by why. */}
                  {on ? <span className="fv-seg" data-why="on" style={{ flexGrow: on }} /> : null}
                  {reasons.map((r) => (
                    <button key={r} type="button" className="fv-seg" data-why={r} style={{ flexGrow: s.drops[r] }} aria-label={`${s.drops[r]} ${REASON_WORDS[r]}`} title={`${s.drops[r]} ${REASON_WORDS[r]}`} onClick={() => toggle({ kind: "step", level: i, why: r })} />
                  ))}
                </span>
              </span>
              <ul className="fv-drops">
                {reasons.map((r) => (
                  <li key={r}>
                    <button type="button" className="fv-drop" data-why={r} aria-pressed={same(pick, { kind: "step", level: i, why: r })} onClick={() => toggle({ kind: "step", level: i, why: r })} data-flow-volume-drop={`${s.key}:${r}`}>
                      <i aria-hidden /><b className="lw-num">{s.drops[r]!.toLocaleString()}</b><span className="fv-drop-w">{REASON_WORDS[r]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>

      {pick ? <Items pick={pick} w={w} f={f} days={days} label={label} href={href} select={select} now={now} onClose={() => setPick(null)} /> : null}
    </section>
  );
}

function Items({ pick, w, f, days, label, href, select, now, onClose }: {
  pick: NonNullable<Pick>; w: FunnelWindow; f: NonNullable<FlowMap["funnel"]>; days: number; label: Map<string, string>;
  href: LineViewProps["href"]; select: LineViewProps["select"]; now: number; onClose: () => void;
}) {
  const go = (patch: LineSelectionPatch) => (e: MouseEvent) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select(patch); };
  if (pick.kind === "signals") {
    return (
      <div className="fv-items" data-flow-volume-items="signals">
        <div className="fv-items-head"><b>Signals in</b><span className="lw-num">{w.signals.toLocaleString()}</span><span className="fv-items-n lw-num">{w.sources.length} sources</span><button type="button" className="fv-x" onClick={onClose} aria-label="Close">×</button></div>
        <ul className="fv-rows">
          {w.sources.map((s) => {
            const patch: LineSelectionPatch = { view: "signals", source: s.key, sig: null, stage: null, item: null };
            return (
              <li key={s.key}>
                <a className="fv-row" href={href(patch)} onClick={go(patch)}>
                  <span className="fv-row-title">{label.get(s.key) ?? s.key}</span>
                  <span className="fv-row-at lw-num">{s.n.toLocaleString()}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  const step = w.steps[pick.level];
  const items = funnelItemsOf(f, days, pick.level, pick.why);
  const total = pick.why ? step.drops[pick.why] ?? 0 : step.n;
  return (
    <div className="fv-items" data-flow-volume-items={`${step.key}${pick.why ? `:${pick.why}` : ""}`}>
      <div className="fv-items-head">
        <b>{step.label}</b>
        {pick.why ? <span className="fv-drop" data-why={pick.why}><i aria-hidden />{REASON_WORDS[pick.why]}</span> : null}
        <span className="fv-items-n lw-num">{items.length < total ? `${items.length} of ${total}` : total}</span>
        <button type="button" className="fv-x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <ul className="fv-rows">
        {items.map((x) => {
          const run: LineSelectionPatch | null = x.run ? { view: "problems", run: x.run, case: x.ref ?? x.task } : null;
          const reached = w.steps[x.level];
          return (
            <li key={x.task} className="fv-row">
              <Link className="fv-row-task" href={`/tasks/${x.ref ?? x.task}`}>
                {x.ref ? <span className="fv-ref lw-num">{x.ref}</span> : null}
                <span className="fv-row-title">{x.title}</span>
              </Link>
              {run ? (
                <a className="fv-row-run" href={href(run)} onClick={go(run)} data-status={x.status}>
                  <span>{x.node ?? reached?.label}</span><span className="fv-status">{x.status}</span>
                </a>
              ) : <span className="fv-row-run" data-status="none"><span>No run</span></span>}
              {!pick.why && x.why ? <span className="fv-drop" data-why={x.why} title={`Stopped at ${reached?.label}`}><i aria-hidden /><span className="fv-drop-w">{REASON_WORDS[x.why]}</span></span> : <span />}
              <span className="fv-row-at lw-num">{ageShort(Math.max(0, now - x.at))}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
