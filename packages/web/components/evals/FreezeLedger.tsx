// The assay plate (docs/architecture/evals-ui.md 4.2 and 6): one row per
// freeze, one column per graded batch, in the chart's order. Each well's ink
// is the mean score, its ring the majority verdict, and a notch marks a flip
// on the same footing. Rows with the most flips come first. The plate fills
// column by column in time order, 10 ms apart.

import { useMemo } from "react";
import type { LedgerRow } from "@codecast/shared/contracts/evalsApi";
import { Well } from "./charts/Well";
import { EvalsLink, LockBadge } from "./parts";
import { evalsHref } from "./evalsPaths";
import type { SurfaceColumn } from "./Seismograph";

const WELL = 16;
/** A day label is about three wells wide. */
const LABEL_EVERY = 3;
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Most flips first, then by name: the freezes that moved are the ones to read. */
export const ledgerOrder = (rows: readonly LedgerRow[]) => [...rows].sort((a, b) => b.flips - a.flips || a.name.localeCompare(b.name));

export interface FreezeLedgerProps {
  rows: readonly LedgerRow[];
  /** The graded columns in view, oldest first. */
  columns: readonly SurfaceColumn[];
  pinned: string | null;
  compare: string | null;
  hover: string | null;
  onHover: (batch: string | null) => void;
  onPick: (batch: string, second: boolean) => void;
}

export function FreezeLedger({ rows, columns, pinned, compare, hover, onHover, onPick }: FreezeLedgerProps) {
  const ordered = useMemo(() => ledgerOrder(rows), [rows]);
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
  if (!ordered.length) return <p className="text-[12px] ev-quiet">No freeze has a graded rep in this window.</p>;
  return (
    <div className="ev-sf-ledger" data-ev-ledger>
      <table className="ev-sf-plate" style={{ ["--ev-well" as string]: `${WELL}px` }}>
        <thead>
          <tr>
            <th className="ev-sf-plate-name" scope="col">
              <span className="sr-only">Freeze</span>
            </th>
            {columns.map((c, i) => {
              const pin = pinNumber(c);
              return (
                <th key={c.batch} scope="col" className={`ev-sf-plate-col ${pin ? "is-pinned" : ""} ${hover === c.batch ? "is-hover" : ""}`} data-ev-col={c.batch}>
                  <button
                    type="button"
                    title={`${new Date(c.at).toLocaleString()}: click to pin, shift-click to compare`}
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
          {ordered.map((row) => (
            <tr key={row.freezeId} data-ev-ledger-row={row.freezeId} data-ev-flips={row.flips}>
              <th scope="row" className="ev-sf-plate-name">
                <EvalsLink href={evalsHref.freeze(row.freezeId)} className="ev-sf-plate-link" title={`Open ${row.name} across time`}>
                  <span className="truncate">{row.name}</span>
                </EvalsLink>
                <LockBadge visibility={row.visibility} />
              </th>
              {columns.map((c, ci) => {
                const cell = row.cells[c.batch] ?? null;
                const pin = c.batch === pinned || c.batch === compare;
                return (
                  <td key={c.batch} className={`${pin ? "is-pinned" : ""} ${hover === c.batch ? "is-hover" : ""}`} onMouseEnter={() => onHover(c.batch)} onMouseLeave={() => onHover(null)}>
                    {cell ? (
                      <EvalsLink href={evalsHref.freeze(row.freezeId, { batch: c.batch })} className="ev-sf-well-link" aria-label={`${row.name} at ${new Date(c.at).toLocaleString()}`}>
                        <Well cell={cell} size={WELL} delayMs={ci * 10} title={`${row.name}, ${new Date(c.at).toLocaleString()}: ${cell.passed} of ${cell.reps} passed${cell.mean !== null ? `, mean ${cell.mean.toFixed(2)}` : ""}${cell.flip ? `, ${cell.flip}` : ""}`} />
                      </EvalsLink>
                    ) : (
                      <Well cell={null} size={WELL} title="not run in this batch" />
                    )}
                  </td>
                );
              })}
              <td className={`ev-sf-plate-flips ${row.flips ? "has-flips" : ""}`}>{row.flips || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
