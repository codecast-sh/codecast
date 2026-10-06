// Whether live work is still moving, drawn the same everywhere it is listed:
// "stalled?" on a bisect, a shrink or a sweep that went quiet (its own
// updatedAt), and on a rep still waiting on its grade whose last event is old
// (a product that records events: union's sims). One stall window for all.

import type { HTMLAttributes } from 'react';
import { EVALS_STALL_MS, rowLiveness } from '../../client';
import type { RunRowCore } from '../../contract';
import { useEvalsHost } from '../hooks';

/** The flag every live job wears after five quiet minutes. */
export function StallChip({ since, ...rest }: { since: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="ev-stall-chip" title={`No new step since ${new Date(since).toLocaleTimeString()}: check its tmux session or log`} {...rest}>
      stalled?
    </span>
  );
}

/**
 * A rep's liveness beside its verdict: "running" while its events keep
 * coming, the stall chip once they stop. A rep that is graded, or records no
 * events, shows nothing.
 */
export function LivenessChip({ row, stallMs = EVALS_STALL_MS }: { row: Pick<RunRowCore, 'status' | 'lastEventAt'>; stallMs?: number }) {
  const now = useEvalsHost().useNow(15_000);
  const state = rowLiveness(row, now, stallMs);
  if (state === 'stalled') return <StallChip since={row.lastEventAt!} data-ev-liveness="stalled" />;
  if (state === 'live')
    return (
      <span className="ev-live-chip" data-ev-liveness="live" title={`Last event ${new Date(row.lastEventAt!).toLocaleTimeString()}`}>
        <span className="ev-live-dot ev-pulse" />
        running
      </span>
    );
  return null;
}
