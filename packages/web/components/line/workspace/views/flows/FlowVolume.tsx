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
  closed: "not needed", dropped: "dropped", failed: "failed", cancelled: "cancelled", regressed: "came back", other: "other",
  here: "here now", waiting: "on a person", unowned: "no owner", offsource: "source not taken", unstarted: "eligible, no run",
  held: "held back", watching: "watching",
};

/** A count's height on the chart's one scale: decades of `dec`, so 15,000 signals and 5 merges both read. */
const logF = (n: number, dec: number) => (n > 0 ? Math.max(Math.log10(n), 0) / dec : 0);
const AXIS = ["10", "100", "1k", "10k", "100k", "1M"];
/** The share of the step before that made it to this one; under 1% keeps a decimal so a near-total drop never reads 0. */
function passShare(n: number, prev: number): { text: string; tone?: "warn" | "bad" } | null {
  if (!prev) return null;
  const r = n / prev;
  const text = r > 0 && r < 0.01 ? `${(r * 100).toFixed(1)}%` : `${Math.round(r * 100)}%`;
  return { text, tone: r < 0.5 ? "bad" : r < 0.9 ? "warn" : undefined };
}

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
  // One logarithmic scale for every column, in whole decades from 1 to the largest count.
  const dec = Math.max(1, Math.ceil(Math.log10(Math.max(10, w.signals, ...w.steps.map((s) => s.n)))));
  const label = new Map(map.sources.map((s) => [s.key, s.label]));
  const present = FUNNEL_REASONS.filter((r) => w.steps.some((s) => s.drops[r]));

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

      <ul className="fv-key" aria-label="Key">
        <li data-why="on"><i aria-hidden />went on</li>
        {present.map((r) => <li key={r} data-why={r}><i aria-hidden />{REASON_WORDS[r]}</li>)}
      </ul>

      <ol className="fv-chart" style={{ ["--fv-n" as string]: w.steps.length + 1, ["--fv-dec" as string]: dec }}>
        {/* The scale's decades, so nobody reads the bars as linear. */}
        <li className="fv-col fv-axis" aria-hidden>
          <span className="fv-track">{AXIS.slice(0, dec - 1).map((t, k) => <span key={t} className="fv-tick lw-num" style={{ ["--at" as string]: (k + 1) / dec }}>{t}</span>)}</span>
        </li>
        {/* The signals: many findings to a problem, so no share. */}
        <li className="fv-col" data-step="signals">
          <span className="fv-name">Signals in</span>
          <button type="button" className="fv-count" aria-pressed={pick?.kind === "signals"} onClick={() => toggle({ kind: "signals" })} data-flow-volume-count="signals">
            <b className="lw-num">{w.signals.toLocaleString()}</b>
          </button>
          <span className="fv-track"><span className="fv-bar" data-signals="" style={{ ["--f" as string]: logF(w.signals, dec) }} /></span>
          <ul className="fv-drops">
            {w.sources.slice(0, 3).map((s) => <li key={s.key} className="fv-src"><span>{label.get(s.key) ?? s.key}</span><b className="lw-num">{s.n.toLocaleString()}</b></li>)}
            {w.sources.length > 3 ? <li className="fv-src" data-more=""><button type="button" onClick={() => setPick({ kind: "signals" })}>+{w.sources.length - 3} sources</button></li> : null}
          </ul>
        </li>
        {w.steps.map((s, i) => {
          // The ones that went on to the next step; at the last, all of them made it.
          const on = i === w.steps.length - 1 ? s.n : w.steps[i + 1].n;
          const reasons = FUNNEL_REASONS.filter((r) => s.drops[r]);
          const share = i > 0 ? passShare(s.n, w.steps[i - 1].n) : null;
          return (
            <li key={s.key} className="fv-col" data-step={s.key}>
              <span className="fv-name" title={s.label}>{s.label}</span>
              <button type="button" className="fv-count" aria-pressed={same(pick, { kind: "step", level: i })} disabled={!s.n} onClick={() => toggle({ kind: "step", level: i })} data-flow-volume-count={s.key}>
                <b className="lw-num">{s.n.toLocaleString()}</b>
                {share ? <span className="fv-share lw-num" data-tone={share.tone} title={`of ${w.steps[i - 1].label}`}>{share.text}</span> : null}
              </button>
              <span className="fv-track">
                <span className="fv-bar" data-some={s.n ? "" : undefined} style={{ ["--f" as string]: logF(s.n, dec) }}>
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
                    <button type="button" className="fv-drop" data-why={r} title={`${s.drops[r]} ${REASON_WORDS[r]}`} aria-pressed={same(pick, { kind: "step", level: i, why: r })} onClick={() => toggle({ kind: "step", level: i, why: r })} data-flow-volume-drop={`${s.key}:${r}`}>
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
