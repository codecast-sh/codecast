import { useCallback, useRef, useState } from "react";
import { lineSeqAt, turnIndexAt } from "../lib/calls/callVideo";

/** Where a call's media is (ms since the call started) and whether it plays. */
export type MediaMoment = { ms: number; playing: boolean };

type MomentTurns = ReadonlyArray<{ t0: number; segments: ReadonlyArray<{ seq: number; t0: number; t1?: number }> }>;

/** The line a page lights at a moment, as one value: the turn (held through a
 *  silence while paused, as the page lights it) and the line inside it, since
 *  one turn can hold minutes of one speaker. */
export function litLineSig(turns: MomentTurns, m: MediaMoment): string {
  const i = turnIndexAt(turns, m.ms, !m.playing);
  return i === null ? "none" : `${i}:${lineSeqAt(turns[i], m.ms)}`;
}

/**
 * The media's moment as a page that lights the transcript needs it. A player
 * reports its time about four times a second, and a call page that re-rendered
 * on each report would redraw every passage and row of a long call to light
 * the same line. So the page renders only when what it shows moves: the line
 * lit (litLineSig: the line, not only its turn), or play and pause. `set`
 * is for the page's own moves (a seek, landing on a linked moment), which
 * always render.
 */
export function useMediaMoment(turns: MomentTurns): {
  at: MediaMoment | null;
  onTime: (ms: number, playing: boolean) => void;
  set: (at: MediaMoment | null) => void;
} {
  const [at, setAt] = useState<MediaMoment | null>(null);
  const last = useRef<MediaMoment | null>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const onTime = useCallback((ms: number, playing: boolean) => {
    const prev = last.current;
    last.current = { ms, playing };
    if (prev && prev.playing === playing && litLineSig(turnsRef.current, prev) === litLineSig(turnsRef.current, last.current)) return;
    setAt(last.current);
  }, []);
  const set = useCallback((next: MediaMoment | null) => {
    last.current = next;
    setAt(next);
  }, []);
  return { at, onTime, set };
}
