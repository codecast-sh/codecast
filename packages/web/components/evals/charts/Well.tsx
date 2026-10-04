// One well of the assay plate: a freeze in one batch. Ink density is the mean
// score, the ring is the majority verdict (whole for pass, broken for fail, so
// state never rests on colour alone), and a notch on top marks a flip on the
// same footing: magenta when it broke, cyan when it was fixed.

import type { CSSProperties } from "react";
import type { LedgerCell } from "@codecast/shared/contracts/evalsApi";
import { wellInk } from "./scale";

export interface WellProps {
  cell: Pick<LedgerCell, "mean" | "majority" | "flip" | "reps"> | null;
  /** Diameter in px. */
  size?: number;
  title?: string;
  onClick?: () => void;
  /** The entrance pop's delay, for a plate filling column by column. */
  delayMs?: number;
}

export function Well({ cell, size = 14, title, onClick, delayMs }: WellProps) {
  const style = delayMs !== undefined ? ({ "--ev-delay": `${delayMs}ms` } as CSSProperties) : undefined;
  const verdict = cell?.majority === true ? "pass" : cell?.majority === false ? "fail" : null;
  const svg = (
    <svg
      className={`ev-well ${verdict ? `ev-${verdict}` : "ev-quiet"}`}
      width={size}
      height={size}
      viewBox="-8 -8 16 16"
      role="img"
      aria-label={title ?? wellLabel(cell)}
      data-ev-well={verdict ?? "none"}
      data-ev-flip={cell?.flip ?? undefined}
    >
      {title && <title>{title}</title>}
      <g className={delayMs !== undefined ? "ev-pop" : undefined} style={style}>
        {cell ? (
          <>
            <circle r={6} className="ev-well-ink" style={{ fillOpacity: wellInk(cell.mean) }} />
            <circle r={6.4} className="ev-well-ring" strokeDasharray={verdict === "fail" ? "3.2 1.8" : undefined} />
            {cell.flip && <path d="M-2.6,-8.4 L2.6,-8.4 L0,-4.6 Z" className={cell.flip === "broke" ? "ev-fail" : "ev-pass"} fill="currentColor" />}
          </>
        ) : (
          <circle r={6} className="ev-well-empty" />
        )}
      </g>
    </svg>
  );
  if (!onClick) return svg;
  return (
    <button type="button" className="ev-well-button" onClick={onClick} aria-label={title ?? wellLabel(cell)}>
      {svg}
    </button>
  );
}

function wellLabel(cell: WellProps["cell"]): string {
  if (!cell) return "not run";
  const verdict = cell.majority === null ? "not scored" : cell.majority ? "passed by majority" : "failed by majority";
  const mean = cell.mean === null ? "" : `, mean ${cell.mean.toFixed(2)}`;
  const flip = cell.flip ? `, ${cell.flip}` : "";
  return `${cell.reps} reps ${verdict}${mean}${flip}`;
}
