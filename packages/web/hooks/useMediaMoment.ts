import { useCallback, useRef, useState } from "react";
import { turnIndexAt } from "../lib/calls/callVideo";

/** Where a call's media is (ms since the call started) and whether it plays. */
export type MediaMoment = { ms: number; playing: boolean };

/**
 * The media's moment as a page that lights the transcript needs it. A player
 * reports its time about four times a second, and a call page that re-rendered
 * on each report would redraw every passage and row of a long call to light
 * the same line. So the page renders only when what it shows moves: the line
 * lit (held through a silence while paused, as the page lights it), or play
 * and pause. `set` is for the page's own moves (a seek, landing on a linked
 * moment), which always render.
 */
export function useMediaMoment(turns: ReadonlyArray<{ t0: number; segments: ReadonlyArray<{ t1?: number }> }>): {
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
    const lit = (m: MediaMoment) => turnIndexAt(turnsRef.current, m.ms, !m.playing);
    if (prev && prev.playing === playing && lit(prev) === lit(last.current)) return;
    setAt(last.current);
  }, []);
  const set = useCallback((next: MediaMoment | null) => {
    last.current = next;
    setAt(next);
  }, []);
  return { at, onTime, set };
}
