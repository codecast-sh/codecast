// The assay plate (docs/architecture/evals-ui.md 4.2 and 6): one row per
// freeze, one column per graded batch in the chart's order, or per day where
// batches are sparse (ledgerPlate). Each well's ink
// is the mean score, its ring the majority verdict, and a notch marks a flip
// on the same footing. Rows with the most flips come first; with two batches
// pinned, the freezes that flipped between them come first and are marked.
// The plate fills column by column in time order, 10 ms apart.

import { useLayoutEffect, useMemo, useRef } from "react";
import { type LedgerColumn, type LedgerPlate, capitalized, dayLabel, ledgerOrder, plateColumnOf, whenLabel } from "../../client";
import type { VerdictFlip } from "../../contract";
import { useCaseNoun, useEvalsPaths } from "../hooks";
import { LockBadge, PageLink } from "../shell/parts";
import { Well } from "../shell/Well";

const WELL = 16;
/** A day label is about three wells wide. */
const LABEL_EVERY = 3;

export interface FreezeLedgerProps {
  /** The ledger over the graded columns in view (ledgerPlate). */
  plate: LedgerPlate;
  pinned: string | null;
  compare: string | null;
  hover: string | null;
  onHover: (batch: string | null) => void;
  onPick: (batch: string, second: boolean) => void;
  /** The pinned pair's flips (GET /batches, the drawer's answer), by freeze; null while no pair is pinned or it is loading. */
  pairFlips?: ReadonlyMap<string, VerdictFlip["direction"]> | null;
}

export function FreezeLedger({ plate, pinned, compare, hover, onHover, onPick, pairFlips = null }: FreezeLedgerProps) {
  const noun = useCaseNoun();
  const paths = useEvalsPaths();
  const { columns, by } = plate;
  const ordered = useMemo(() => ledgerOrder(plate.rows, pairFlips), [plate.rows, pairFlips]);
  const held = (c: LedgerColumn, batch: string | null) => !!batch && c.batches.includes(batch);
  // A click acts on the column's pin when it holds one (so it unpins), else on its newest batch.
  const target = (c: LedgerColumn) => [pinned, compare].find((b) => held(c, b)) ?? c.batch;
  const when = (at: number) => (by === "day" ? dayLabel(at) : whenLabel(at));
  const scroller = useRef<HTMLDivElement>(null);
  // The plate scrolls sideways once the batches outrun the pane. Keep what the
  // reader came for in view: the pinned columns (the later one when both do
  // not fit), else the newest batches and the flip counts at the right end.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const keep = () => {
      if (el.scrollWidth <= el.clientWidth) return;
      const heads = [pinned, compare].flatMap((b) => {
        const col = plateColumnOf(plate, b);
        return col ? [el.querySelector<HTMLElement>(`[data-ev-col="${CSS.escape(col.key)}"]`)] : [];
      }).filter((h): h is HTMLElement => !!h);
      if (!heads.length) {
        el.scrollLeft = el.scrollWidth;
        return;
      }
      const box = el.getBoundingClientRect();
      const at = (h: HTMLElement) => h.getBoundingClientRect().left - box.left + el.scrollLeft;
      const nameW = el.querySelector<HTMLElement>(".ev-sf-plate-name")?.getBoundingClientRect().width ?? 0;
      const left = Math.min(...heads.map(at)) - nameW - 8;
      // A pin on the newest batch brings the flip counts beside it along.
      const flipsHead = columns.length && (held(columns[columns.length - 1], pinned) || held(columns[columns.length - 1], compare)) ? el.querySelector<HTMLElement>("thead .ev-sf-plate-flips") : null;
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
  }, [pinned, compare, plate]);
  // Labels sit at least LABEL_EVERY columns apart and never in the last two, where the flips head is.
  const dayHeads = useMemo(() => {
    let last = -Infinity;
    return columns.map((c, i) => {
      const newDay = i === 0 || dayLabel(columns[i - 1].at) !== dayLabel(c.at);
      if (!newDay || i - last < LABEL_EVERY || i > columns.length - 3) return null;
      last = i;
      return dayLabel(c.at);
    });
  }, [columns]);
  // Numbered by time, as the compare drawer numbers them: the earlier pin is 1.
  const pins = columns.filter((c) => held(c, pinned) || held(c, compare));
  const pinNumber = (c: LedgerColumn) => (pins.includes(c) ? String(pins.indexOf(c) + 1) : null);
  if (!ordered.length) return <p className="ev-note">No {noun.one} has a graded rep in this window.</p>;
  return (
    <div ref={scroller} className="ev-sf-ledger" data-ev-ledger>
      <table className="ev-sf-plate" style={{ ["--ev-well" as string]: `${WELL}px` }}>
        <thead>
          <tr>
            <th className="ev-sf-plate-name" scope="col">
              <span className="ev-sr-only">{capitalized(noun.one)}</span>
            </th>
            {columns.map((c, i) => {
              const pin = pinNumber(c);
              return (
                <th key={c.key} scope="col" className={`ev-sf-plate-col ${pin ? "ev-sf-plate-pinned" : ""} ${held(c, hover) ? "ev-sf-plate-hovered" : ""}`} data-ev-col={c.key}>
                  <button
                    type="button"
                    title={`${when(c.at)}${by === "day" ? `, ${c.batches.length} ${c.batches.length === 1 ? "batch" : "batches"}` : ""}: click to pin, shift-click to compare`}
                    aria-pressed={!!pin}
                    onClick={(e) => onPick(target(c), e.shiftKey)}
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
                <PageLink needs="freezes" href={paths.href.freeze(row.freezeId)} className="ev-sf-plate-link" title={`Open ${row.name} across time`}>
                  <span className="ev-truncate">{row.name}</span>
                </PageLink>
                <LockBadge visibility={row.visibility} />
              </th>
              {columns.map((c, ci) => {
                const cell = row.cells[c.key] ?? null;
                const pin = held(c, pinned) || held(c, compare);
                return (
                  <td key={c.key} className={`${pin ? "ev-sf-plate-pinned" : ""} ${held(c, hover) ? "ev-sf-plate-hovered" : ""}`} onMouseEnter={() => onHover(c.batch)} onMouseLeave={() => onHover(null)}>
                    {cell ? (
                      <PageLink needs="freezes" href={paths.href.freeze(row.freezeId, { batch: row.batchOf[c.key] })} className="ev-sf-well-link" aria-label={`${row.name} at ${when(c.at)}`}>
                        <Well cell={cell} size={WELL} delayMs={ci * 10} title={`${row.name}, ${when(c.at)}: ${cell.passed} of ${cell.reps} passed${cell.mean !== null ? `, mean ${cell.mean.toFixed(2)}` : ""}${cell.flip ? `, ${cell.flip}` : ""}`} />
                      </PageLink>
                    ) : (
                      <Well cell={null} size={WELL} title={by === "day" ? "not run this day" : "not run in this batch"} />
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
