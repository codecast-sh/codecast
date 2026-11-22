"use client";
// One lane's passing path as a track (pipeline.md PL6): pills on one line,
// spread across the lane, a side-by-side group as a fork between brackets,
// one small line under each pill saying what it runs or who does it. State is
// quiet: a small count beside a pill's corner (its changes on hover), stalled
// ones counted apart in red, a proposed edit as a dashed amber outline with
// EDIT inside, a step with no command as a hollow dashed pill that "passes",
// the station the last release failed at painted red with when and where.
// Stations off the path are named, muted, under the one that sends changes
// there. Pressing a pill opens its station; with `onAdd`, a "+" shows in each
// gap a station can go (never inside a fork). The model is
// lib/line/pipelineView.ts.
import { Fragment } from "react";
import type { TrackItem, TrackPill } from "../../../lib/line/pipelineView";

export function PipelineTrack({ items, picked = null, onOpen, onAdd, small = false }: {
  items: TrackItem[];
  picked?: string | null;
  onOpen?: (id: string) => void;
  /** Add a station between two (`after` null: before the first station). */
  onAdd?: (after: string | null, before: string | null) => void;
  small?: boolean;
}) {
  return (
    <ol className="pt-track" data-small={small ? "" : undefined}>
      {items.map((it, i) => (
        <Fragment key={it.id ?? it.label}>
          {onAdd && i > 0 ? (
            <li className="pt-gap">
              <button type="button" className="pt-add" onClick={() => onAdd(items[i - 1].id, it.id)} aria-label={`Add a station after ${items[i - 1].label}`} title={`Add a station after ${items[i - 1].label}`} data-pt-add>+</button>
            </li>
          ) : null}
          {it.type === "fork" ? (
            <li className="pt-item pt-fork" aria-label={it.label} title={it.label}>
              {it.count ? <Count n={it.count} stalled={0} names={it.names} fork /> : null}
              <ul className="pt-branches">
                {it.branches.map((b) => <li key={b.id ?? b.label} className="pt-branch"><Pill p={b} picked={picked} onOpen={onOpen} small={small} /></li>)}
              </ul>
              {!small && it.off.length ? <span className="pt-off pt-off-fork" title={`Changes can go on to ${it.off.join(", ")}`}>↳ {it.off.join(", ")}</span> : null}
            </li>
          ) : (
            <li className="pt-item"><Pill p={it} picked={picked} onOpen={onOpen} small={small} /></li>
          )}
        </Fragment>
      ))}
    </ol>
  );
}

/** A pill's counts: the changes moving here, and apart in red those that have stalled. */
function Count({ n, stalled, names, fork = false }: { n: number; stalled: number; names: string[]; fork?: boolean }) {
  const moving = n - stalled;
  return (
    <span className={fork ? "pt-counts pt-counts-fork" : "pt-counts"} title={names.join("\n") || undefined}>
      {moving ? <span className="pt-count" aria-label={`${moving} here`}>{moving}</span> : null}
      {stalled ? <span className="pt-count" data-stalled aria-label={`${stalled} stalled here`}>{stalled}</span> : null}
    </span>
  );
}

function Pill({ p, picked, onOpen, small }: { p: TrackPill; picked: string | null; onOpen?: (id: string) => void; small: boolean }) {
  const body = (
    <>
      {p.kind !== "none" ? <span className="pt-ico" data-kind={p.kind} aria-hidden /> : null}
      <span className="pt-name">{p.label}</span>
      {p.proposed ? <span className="pt-tag" title={p.proposed}>{p.skipped ? "skip" : "edit"}</span> : null}
    </>
  );
  const attrs = { className: "pt-pill", "data-kind": p.kind, "data-proposed": p.proposed ? "" : undefined, "data-skipped": p.skipped ? "" : undefined, "data-failed": p.failed ? "" : undefined, "data-picked": p.id && picked === p.id ? "" : undefined };
  return (
    <span className="pt-station" data-into-main={p.intoMain && !small ? "" : undefined}>
      {p.id && onOpen ? <button type="button" {...attrs} onClick={() => onOpen(p.id!)} aria-pressed={picked === p.id} data-pt-open={p.id}>{body}</button> : <span {...attrs}>{body}</span>}
      {p.count ? <Count n={p.count} stalled={p.stalled} names={p.names} /> : null}
      {!small && (p.failed || p.sub || p.off.length) ? (
        <span className="pt-under">
          {p.failed ? <span className="pt-sub" data-tone="bad">{p.failed}</span> : p.sub ? <span className="pt-sub">{p.sub}</span> : null}
          {p.off.length ? <span className="pt-off" title={`Changes can go on to ${p.off.join(", ")}`}>↳ {p.off.join(", ")}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
