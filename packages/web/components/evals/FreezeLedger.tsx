// The assay plate (docs/architecture/evals-ui.md 4.2 and 6): one row per
// freeze, one column per graded batch, in the chart's order. Each well's ink
// is the mean score, its ring the majority verdict, and a notch marks a flip
// on the same footing. Rows with the most flips come first; with two batches
// pinned, the freezes that flipped between them come first and are marked.
// The plate fills column by column in time order, 10 ms apart.

import { useLayoutEffect, useMemo, useRef } from "react";
import type { LedgerRow, VerdictFlip } from "@codecast/shared/contracts/evalsApi";
import { Well } from "./charts/Well";
import { EvalsLink, LockBadge } from "./parts";
import { evalsHref } from "./evalsPaths";
import type { SurfaceColumn } from "./seismographModel";
import { ledgerOrder } from "./surfaceModel";
import { whenLabel } from "./format";

const WELL = 16;
/** A day label is about three wells wide. */
const LABEL_EVERY = 3;
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export interface FreezeLedgerProps {
  rows: readonly LedgerRow[];
  /** The graded columns in view, oldest first. */
  columns: readonly SurfaceColumn[];
  pinned: string | null;
  compare: string | null;
  hover: string | null;
  onHover: (batch: string | null) => void;
  onPick: (batch: string, second: boolean) => void;
  /** The pinned pair's flips (GET /batches, the drawer's answer), by freeze; null while no pair is pinned or it is loading. */
  pairFlips?: ReadonlyMap<string, VerdictFlip["direction"]> | null;
}

export function FreezeLedger({ rows, columns, pinned, compare, hover, onHover, onPick, pairFlips = null }: FreezeLedgerProps) {
  const ordered = useMemo(() => ledgerOrder(rows, pairFlips), [rows, pairFlips]);
  const scroller = useRef<HTMLDivElement>(null);
  // The plate scrolls sideways once the batches outrun the pane. Keep what the
  // reader came for in view: the pinned columns (the later one when both do
  // not fit), else the newest batches and the flip counts at the right end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const keep = () => {
      if (el.scrollWidth <= el.clientWidth) return;
      const heads = [pinned, compare].flatMap((b) => (b ? [el.querySelector<HTMLElement>(`[data-ev-col="${CSS.escape(b)}"]`)] : [])).filter((h): h is HTMLElement => !!h);
      if (!heads.length) {
        el.scrollLeft = el.scrollWidth;
        return;
      }
      const box = el.getBoundingClientRect();
      const at = (h: HTMLElement) => h.getBoundingClientRect().left - box.left + el.scrollLeft;
      const nameW = el.querySelector<HTMLElement>(".ev-sf-plate-name")?.getBoundingClientRect().width ?? 0;
      const left = Math.min(...heads.map(at)) - nameW - 8;
      // A pin on the newest batch brings the flip counts beside it along.
      const flipsHead = columns.length && [pinned, compare].includes(columns[columns.length - 1].batch) ? el.querySelector<HTMLElement>("thead .ev-sf-plate-flips") : null;
      const right = Math.max(...[...heads, ...(flipsHead ? [flipsHead] : [])].map((h) => at(h) + h.getBoundingClientRect().width)) + 8;
      let next = el.scrollLeft;
      if (left < next) next = left;
      if (right > next + el.clientWidth) next = right - el.clientWidth;
      el.scrollLeft = Math.max(0, next);
    };
    keep();
    // The pane narrows when the compare drawer opens beside the plate.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keep);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [pinned, compare, columns]);
  // Labels sit at least LABEL_EVERY columns apart and never in the last two, where the flips head is.
  const dayHeads = useMemo(() => {
    let last = -Infinity;
    return columns.map((c, i) => {
      const newDay = i === 0 || fmtDay(columns[i - 1].at) !== fmtDay(c.at);
      if (!newDay || i - last < LABEL_EVERY || i > columns.length - 3) return null;
      last = i;
      return fmtDay(c.at);
    });
  }, [columns]);
  // Numbered by time, as the compare drawer numbers them: the earlier pin is 1.
  const pins = columns.filter((c) => c.batch === pinned || c.batch === compare);
  const pinNumber = (c: SurfaceColumn) => (pins.includes(c) ? String(pins.indexOf(c) + 1) : null);
  if (!ordered.length) return <p className="ev-note">No freeze has a graded rep in this window.</p>;
  return (
    <div ref={scroller} className="ev-sf-ledger" data-ev-ledger>
      <table className="ev-sf-plate" style={{ ["--ev-well" as string]: `${WELL}px` }}>
        <thead>
          <tr>
            <th className="ev-sf-plate-name" scope="col">
              <span className="ev-sr-only">Freeze</span>
            </th>
            {columns.map((c, i) => {
              const pin = pinNumber(c);
              return (
                <th key={c.batch} scope="col" className={`ev-sf-plate-col ${pin ? "ev-sf-plate-pinned" : ""} ${hover === c.batch ? "ev-sf-plate-hovered" : ""}`} data-ev-col={c.batch}>
                  <button
                    type="button"
                    title={`${whenLabel(c.at)}: click to pin, shift-click to compare`}
                    aria-pressed={!!pin}
                    onClick={(e) => onPick(c.batch, e.shiftKey)}
                    onMouseEnter={() => onHover(c.batch)}
                    onMouseLeave={() => onHover(null)}
                  >
                    {pin ? <span className="ev-sf-plate-pin">{pin}</span> : dayHeads[i] ? <span className="ev-sf-plate-day">{dayHeads[i]}</span> : <span className="ev-sf-plate-tick" />}
                  </button>
                </th>
              );
            })}
            <th scope="col" className="ev-sf-plate-flips">flips</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => {
            const flipped = pairFlips?.get(row.freezeId) ?? null;
            return (
            <tr key={row.freezeId} data-ev-ledger-row={row.freezeId} data-ev-flips={row.flips} data-ev-pair-flip={flipped ?? undefined}>
              <th scope="row" className="ev-sf-plate-name">
                {flipped && (
                  <span className={`ev-sf-pairflip ${flipped === "broke" ? "ev-fail" : "ev-pass"}`} title={`${flipped === "broke" ? "Broke" : "Fixed"} between the two pinned batches`} aria-label={`${flipped} between the pinned batches`} />
                )}
                <EvalsLink href={evalsHref.freeze(row.freezeId)} className="ev-sf-plate-link" title={`Open ${row.name} across time`}>
                  <span className="ev-truncate">{row.name}</span>
                </EvalsLink>
                <LockBadge visibility={row.visibility} />
              </th>
              {columns.map((c, ci) => {
                const cell = row.cells[c.batch] ?? null;
                const pin = c.batch === pinned || c.batch === compare;
                return (
                  <td key={c.batch} className={`${pin ? "ev-sf-plate-pinned" : ""} ${hover === c.batch ? "ev-sf-plate-hovered" : ""}`} onMouseEnter={() => onHover(c.batch)} onMouseLeave={() => onHover(null)}>
                    {cell ? (
                      <EvalsLink href={evalsHref.freeze(row.freezeId, { batch: c.batch })} className="ev-sf-well-link" aria-label={`${row.name} at ${whenLabel(c.at)}`}>
                        <Well cell={cell} size={WELL} delayMs={ci * 10} title={`${row.name}, ${whenLabel(c.at)}: ${cell.passed} of ${cell.reps} passed${cell.mean !== null ? `, mean ${cell.mean.toFixed(2)}` : ""}${cell.flip ? `, ${cell.flip}` : ""}`} />
                      </EvalsLink>
                    ) : (
                      <Well cell={null} size={WELL} title="not run in this batch" />
                    )}
                  </td>
                );
              })}
              <td className={`ev-sf-plate-flips ${row.flips ? "ev-sf-plate-flips--some" : ""}`}>{row.flips || ""}</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
