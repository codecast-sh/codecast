import { useRef, type RefObject } from "react";
import type { CallView } from "@codecast/shared/contracts";
import type { CallVideoHandle } from "../components/calls/CallVideoPlayer";
import { turnIndexAt } from "../lib/calls/callVideo";
import { scrollIntoContainer } from "../lib/scrollWithin";
import { useWatchEffect } from "./useWatchEffect";
import type { MediaMoment } from "./useMediaMoment";

/**
 * The media a call page's words follow: the room's video when there is one,
 * else a recording's audio. The call page and the public share page both
 * seek through this, so a line pressed or a moment linked behaves the same on
 * either.
 */
export type CallMediaTarget = {
  hasVideo: boolean;
  player: RefObject<CallVideoHandle | null>;
  audio: RefObject<HTMLAudioElement | null>;
  media: { set: (at: MediaMoment | null) => void };
  /** A moment no video shows: said under the picture until the next seek
   *  that lands, so the picture and the lit line never disagree silently. */
  setMissed: (ms: number | null) => void;
};

/**
 * Seeks the call's media to `ms` (since the call started), playing unless
 * told not to. Audio reports its time only once it plays, so the page's
 * moment is set here at once and the lit line moves in the same frame. A
 * playing video reports its own time; a paused one (a landing) is set here,
 * since the line must light whether or not the picture covers that moment.
 */
export function seekCallMedia(t: CallMediaTarget, ms: number, opts: { play?: boolean; view?: CallView | null } = {}): void {
  const play = opts.play ?? true;
  if (t.hasVideo) {
    t.setMissed(t.player.current?.seek(ms, { play, view: opts.view }) === false ? ms : null);
    if (play) return;
  } else {
    const el = t.audio.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
    if (play) void el.play().catch(() => {});
  }
  t.media.set({ ms, playing: play });
}

/**
 * A link to a moment (`?t=754`, what `cl-42@12:34` opens): the media waits
 * there (not playing: the page was opened, not pressed) and the line said
 * then is lit and brought into view. A call filmed with transcription off has
 * video and no lines, and still lands, on the picture alone.
 *
 * `scope` names what the page shows (a call id): each scope and moment lands
 * once, so a second link opened on the same mount lands too, and a re-render
 * never yanks the reader back. `ready` holds the landing until the page knows
 * whether there is video, so a slow recordings query does not land on the
 * words alone. The picture and the line land separately: the media can be
 * ready before the words are, and the line is brought into view once there
 * are lines to bring. `lineEl` finds the i-th turn's element inside the
 * page's own thread.
 */
export function useCallMomentLanding({
  scope,
  momentMs,
  view,
  turns,
  ready,
  target,
  lineEl,
}: {
  scope: string;
  momentMs: number | null;
  view?: CallView | null;
  turns: ReadonlyArray<{ t0: number; segments: ReadonlyArray<{ t1?: number }> }>;
  ready: boolean;
  target: CallMediaTarget;
  lineEl: (i: number) => HTMLElement | null;
}): void {
  const landedMoment = useRef<string | null>(null);
  const landedLine = useRef<string | null>(null);
  useWatchEffect(() => {
    if (momentMs === null || !ready || (turns.length === 0 && !target.hasVideo)) return;
    const key = `${scope}@${momentMs}`;
    if (landedMoment.current !== key) {
      landedMoment.current = key;
      seekCallMedia(target, momentMs, { play: false, view });
    }
    if (landedLine.current === key || turns.length === 0) return;
    landedLine.current = key;
    const i = turnIndexAt(turns, momentMs, true);
    if (i === null) return;
    // A timer, not a frame: the fold opens the passage first, and frames
    // stall in a background tab. Only the thread scrolls
    // (scrollIntoContainer): scrollIntoView would move the page around it
    // too and slice the title off the top.
    setTimeout(() => {
      const el = lineEl(i);
      if (el) scrollIntoContainer(el, { block: "center" });
    }, 80);
  }, [scope, momentMs, turns.length, target.hasVideo, ready]);
}
