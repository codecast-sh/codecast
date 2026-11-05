"use client";
// The Flows stage's list of live flows (FlowsStage): one row per flow of the
// live family, then the runs off it and the sources that file nowhere. A row
// names the flow and its role, counts what runs, what waits on a person (a
// link to For you on that flow) and what stalled, and names only the stations
// holding work, each opening that station. Pressing a row draws its map.
import type { MouseEvent } from "react";
import type { FlowMap, FlowMapLane, FlowMapStep } from "@codecast/shared/contracts/flowMap";
import { processKeyOf } from "../../../../../lib/line/lineGraphs";
import type { LineSelectionPatch } from "../../../../../lib/line/lineWorkspaceUrl";
import type { LineViewProps } from "../types";

/** The stations a row names before "+N". */
const HOT_SHOWN = 3;
const ROLE: Record<FlowMapLane["kind"], string> = { spine: "Main", variant: "Variant", judge: "Judges" };

type Go = { href: string; go: () => void };
const follow = (to: Go) => (e: MouseEvent) => { e.stopPropagation(); if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); to.go(); };
const sum = (steps: FlowMapStep[], k: "running" | "stalled" | "waiting") => steps.reduce((n, s) => n + s[k], 0);
/** Stations holding any live run, in the flow's order. */
const hot = (steps: FlowMapStep[]) => steps.filter((s) => s.running || s.waiting || s.stalled);
/** The busiest few of them (stalled weighs most, then on a person), still in the flow's order. */
const busiest = (busy: FlowMapStep[]) => {
  const top = new Set([...busy].sort((a, b) => b.stalled - a.stalled || b.waiting - a.waiting || b.running - a.running).slice(0, HOT_SHOWN));
  return busy.filter((s) => top.has(s));
};

export function FlowList({ map, drawn, select, href }: { map: FlowMap; drawn: string; select: LineViewProps["select"]; href: LineViewProps["href"] }) {
  const signals: LineSelectionPatch = { view: "signals", sig: null, stage: null, item: null, source: null };
  const unfiled = map.sources.filter((s) => s.route === "unfiled");
  const off = map.off.steps;
  return (
    <nav className="fs-list" aria-label="Live flows" data-flow-lanes={map.lanes.length}>
      <h2 className="fs-col-h">Flows<span className="lw-num">{map.lanes.length}</span></h2>
      <ul>
        {map.lanes.map((lane) => {
          const key = processKeyOf(lane.key);
          return (
            <FlowRow key={lane.key} laneKey={lane.key} name={lane.label} role={ROLE[lane.kind]} steps={lane.steps} current={key === drawn}
              draw={{ href: href({ graph: key, step: null }), go: () => select({ graph: key, step: null }) }}
              onPerson={{ href: href({ view: "foryou", process: key, step: null, show: null }), go: () => select({ view: "foryou", process: key, step: null, show: null }) }}
              openStep={(id) => ({ href: href({ graph: key, step: id }), go: () => select({ graph: key, step: id }) })}
              sources={lane.sources.length} />
          );
        })}
      </ul>
      {off.length || unfiled.length ? (
        <ul className="fs-list-rest">
          {off.length ? <FlowRow laneKey="off" name="Outside the live flows" steps={off} current={false} /> : null}
          {unfiled.length ? (
            <li data-flow-lane="unfiled">
              <a className="fs-row fs-row-link" href={href(signals)} onClick={follow({ href: href(signals), go: () => select(signals) })} title={unfiled.map((s) => s.label).join(", ")}>
                <span className="fs-row-name">Not filed</span>
                <span className="fs-row-figs"><span data-tone="bad"><b className="lw-num">{unfiled.length}</b> {unfiled.length === 1 ? "source" : "sources"}</span></span>
              </a>
            </li>
          ) : null}
        </ul>
      ) : null}
    </nav>
  );
}

function FlowRow({ laneKey, name, role, steps, current, draw, onPerson, openStep, sources }: {
  laneKey: string; name: string; role?: string; steps: FlowMapStep[]; current: boolean; draw?: Go; onPerson?: Go;
  openStep?: (id: string) => Go; sources?: number;
}) {
  const running = sum(steps, "running");
  const waiting = sum(steps, "waiting");
  const stalled = sum(steps, "stalled");
  const busy = hot(steps);
  const idle = !running && !waiting && !stalled;
  const head = (
    <>
      <span className="fs-row-top">
        <i className="fs-row-dot" data-state={stalled ? "bad" : waiting ? "you" : running ? "live" : "idle"} aria-hidden />
        {draw ? <a className="fs-row-name" href={draw.href} onClick={follow(draw)}>{name}</a> : <span className="fs-row-name">{name}</span>}
        {role ? <span className="fs-row-role">{role}</span> : null}
      </span>
      <span className="fs-row-figs">
        {running ? <span><b className="lw-num">{running}</b> running</span> : null}
        {waiting ? (onPerson
          ? <a data-tone="you" href={onPerson.href} onClick={follow(onPerson)} data-flow-lane-person={waiting}><b className="lw-num">{waiting}</b> on a person</a>
          : <span data-tone="you"><b className="lw-num">{waiting}</b> on a person</span>) : null}
        {stalled ? <span data-tone="bad"><b className="lw-num">{stalled}</b> stalled</span> : null}
        {idle ? <span>Idle{sources ? ` · ${sources} ${sources === 1 ? "source" : "sources"}` : ""}</span> : null}
      </span>
    </>
  );
  return (
    <li data-flow-lane={laneKey} aria-current={current ? "true" : undefined} data-idle={idle ? "" : undefined} data-link={draw ? "" : undefined}>
      {/* The whole row draws the flow's map; its name is the real link, so keys and a new tab reach it too. */}
      <div className="fs-row" data-link={draw ? "" : undefined} onClick={draw ? () => draw.go() : undefined}>{head}</div>
      {busy.length ? (
        <span className="fs-hot">
          {busiest(busy).map((s) => {
            const body = <><span className="fs-hot-l">{s.label}</span><b className="lw-num" data-tone={s.stalled ? "bad" : s.waiting ? "you" : undefined}>{s.running + s.waiting}</b></>;
            const title = [s.running ? `${s.running} running` : null, s.waiting ? `${s.waiting} on a person` : null, s.stalled ? `${s.stalled} stalled` : null].filter(Boolean).join(" · ");
            const to = openStep?.(s.id);
            return to
              ? <a key={s.id} className="fs-hot-s" href={to.href} onClick={follow(to)} title={title} data-flow-step={s.id}>{body}</a>
              : <span key={s.id} className="fs-hot-s" title={title} data-flow-step={s.id}>{body}</span>;
          })}
          {busy.length > HOT_SHOWN ? <span className="fs-hot-more">+{busy.length - HOT_SHOWN}</span> : null}
        </span>
      ) : null}
    </li>
  );
}
