// Whether live work is still moving, as every page asks it: a running rep
// against its newest event (a product that records events, union's sims), a
// bisect or a job against its last step. One stall window for all of them.

import { EVALS_STALL_MS, liveness } from '../analysis';
import type { RunRowCore } from '../contract';

export { EVALS_STALL_MS };

/** Nothing written since `updatedAt` for longer than the stall window. */
export const quietTooLong = (updatedAt: string, now: number, stallMs = EVALS_STALL_MS): boolean => now - Date.parse(updatedAt) > stallMs;

/**
 * A rep's liveness: only a rep still waiting on its grade can be live, so a
 * finished one shows none whatever its last event says. Null for a rep that
 * records no events.
 */
export const rowLiveness = (row: Pick<RunRowCore, 'status' | 'lastEventAt'>, now: number, stallMs = EVALS_STALL_MS): 'live' | 'stalled' | null =>
  row.status === 'unscored' ? liveness(row.lastEventAt, now, stallMs) : null;
