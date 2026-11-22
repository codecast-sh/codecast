"use client";
// One lane's passing path as a track (pipeline.md PL6): pills on one line,
// spread across the lane, a side-by-side group as a fork between brackets,
// one small line under each pill saying who or what does it. State is quiet:
// a small count on a pill's corner (its changes on hover), a proposed edit as
// a dashed amber outline with EDIT inside, a step with no command as a hollow
// dashed pill. Pressing a pill opens its station. The model is
// lib/line/pipelineView.ts.
import type { TrackItem, TrackPill } from "../../../lib/line/pipelineView";

export function PipelineTrack({ items, picked = null, onOpen, small = false }: { items: TrackItem[]; picked?: string | null; onOpen?: (id: string) => void; small?: boolean }) {
  return (
    <ol className="pt-track" data-small={small ? "" : undefined}>
      {items.map((it) => (it.type === "fork" ? (
        <li key={it.id} className="pt-item pt-fork" aria-label={it.label} title={it.label}>
          {it.count ? <span className="pt-count pt-count-fork" title={it.names.join("\n") || undefined}>{it.count}</span> : null}
          <ul className="pt-branches">
            {it.branches.map((b) => <li key={b.id ?? b.label} className="pt-branch"><Pill p={b} picked={picked} onOpen={onOpen} small={small} /></li>)}
          </ul>
        </li>
      ) : (
        <li key={it.id ?? it.label} className="pt-item"><Pill p={it} picked={picked} onOpen={onOpen} small={small} /></li>
      )))}
    </ol>
  );
}

function Pill({ p, picked, onOpen, small }: { p: TrackPill; picked: string | null; onOpen?: (id: string) => void; small: boolean }) {
  const body = (
    <>
      {p.kind !== "none" ? <span className="pt-ico" data-kind={p.kind} aria-hidden /> : null}
      <span className="pt-name">{p.label}</span>
      {p.proposed ? <span className="pt-tag" title={p.proposed}>{p.skipped ? "skip" : "edit"}</span> : null}
      {p.count ? <span className="pt-count" title={p.names.join("\n") || undefined} aria-label={`${p.count} here`}>{p.count}</span> : null}
    </>
  );
  const attrs = { className: "pt-pill", "data-kind": p.kind, "data-proposed": p.proposed ? "" : undefined, "data-skipped": p.skipped ? "" : undefined, "data-picked": p.id && picked === p.id ? "" : undefined };
  return (
    <span className="pt-station">
      {p.id && onOpen ? <button type="button" {...attrs} onClick={() => onOpen(p.id!)} aria-pressed={picked === p.id} data-pt-open={p.id}>{body}</button> : <span {...attrs}>{body}</span>}
      {!small && p.sub ? <span className="pt-sub">{p.sub}</span> : null}
    </span>
  );
}
