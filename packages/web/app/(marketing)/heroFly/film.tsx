"use client";

/** What the film driver writes beyond styles: typed text, and veils (see filmClock.ts for the rest of the clock). */

import { useCallback, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { SessionCardView } from "@/components/inbox/SessionCardView";
import { fly, POSTER_FRAME, useFilmTime } from "./filmClock";
import { clamp, fade } from "./timeline";

const noop = () => {};
const LIFTED_CHROME = { showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false };
const LIFTED_LIVENESS = { isLive: true, pendingSend: false, restarting: false, draft: "" };

/** Text the driver types (a TextBeat), seeded with its poster-frame value. */
export function FlyText({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) {
  return (
    <span data-fly-text={id} className={className} style={style}>
      {POSTER_FRAME.texts[id]}
    </span>
  );
}

/**
 * A session row in flight between surfaces: the inbox row it is about to
 * become, lifted off the page, its shadow deep enough to part it from the
 * text it crosses. Centred on the flyer's point.
 */
export function LiftedRow({ session, now, spawnedByTitle = null }: Pick<ComponentProps<typeof SessionCardView>, "session" | "now"> & { spawnedByTitle?: string | null }) {
  return (
    <div className="w-[340px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md border border-sol-border/40 bg-sol-bg shadow-[0_18px_40px_-12px_rgba(0,43,54,0.45),0_2px_6px_rgba(0,43,54,0.12)]">
      <SessionCardView
        session={session}
        isActive={false}
        isFavorite={false}
        sessionLabel={null}
        now={now}
        chrome={LIFTED_CHROME}
        liveness={LIFTED_LIVENESS}
        viewerId={null}
        author={null}
        viewers={[]}
        spawnedByTitle={spawnedByTitle}
        anchorIdentity={null}
        onSelect={noop}
      />
    </div>
  );
}

/** A wash of the page colour over a surface (a `scrim` region), faded by its beats: it steps the surface back while the camera frames something else. */
export function Veil({ id }: { id: string }) {
  return <div {...fly(id)} aria-hidden className="pointer-events-none h-full w-full bg-sol-bg/75" />;
}

/**
 * An element's layout height (offsetHeight: its own px, untouched by the 3D
 * transforms around it, where a bounding rect would be the projection), kept
 * as it resizes, and measured the moment the element mounts: the ref is a
 * callback, so a node that appears after its owner mounted is measured too,
 * before that frame paints.
 */
function useLayoutHeight(): [number | null, (n: HTMLElement | null) => (() => void) | undefined] {
  const [h, setH] = useState<number | null>(null);
  const ref = useCallback((n: HTMLElement | null) => {
    if (!n) {
      setH(null);
      return undefined;
    }
    setH(n.offsetHeight);
    const ro = new ResizeObserver(() => setH(n.offsetHeight));
    ro.observe(n);
    return () => ro.disconnect();
  }, []);
  return [h, ref];
}

/**
 * Content that arrives at a film cue and opens its own room: its height grows
 * from 0 to its measured size over `dur` (eased, as a pure function of film
 * time) while it fades in, so a transcript entry or a row inserted into a
 * column pushes what is around it smoothly instead of in one frame. Before
 * `at` it is not mounted; from `at` it is laid out (at no height) and
 * measured, so its first open frame already knows the room it takes; after
 * `dur` it is laid out as normal. With `until` it closes the same way from
 * that cue, and unmounts once closed.
 */
export function FilmGrow({ at, until = Infinity, dur = 0.5, children }: { at: number; until?: number; dur?: number; children: ReactNode }) {
  // Quantised so the views under it re-render about 30 times while it opens or closes, and not at all at rest.
  const k = useFilmTime((t) => {
    if (t < at || t >= until + dur) return -1;
    const open = fade(clamp((t - at) / dur)) * (1 - fade(clamp((t - until) / dur)));
    return Math.round(open * 30) / 30;
  });
  const [h, measure] = useLayoutHeight();
  if (k < 0) return null;
  // flow-root keeps the children's margins inside the measured box, so the height it opens to is the height it rests at.
  return (
    <div style={k >= 1 ? undefined : { height: (h ?? 0) * k, overflow: "clip", opacity: k }}>
      <div ref={measure} className="flow-root">{children}</div>
    </div>
  );
}

/**
 * A view that changes state at film cues inside a real component (rows added
 * to an activity list, a strip advancing), where no single entry can be
 * wrapped: across each cue the new state fades in over the old one, which
 * stays whole underneath, so unchanged pixels never shimmer and what is new
 * dissolves in rather than appearing in one frame; the stack's height eases
 * from the old state's to the new one's over the same crossing, so what sits
 * below moves with it. `render(step)` draws the view after `step` cues have
 * passed. The settled state always renders in the same slot, so the view in
 * it is updated across a cue, never remounted. `ground` is the opaque colour
 * the new state is drawn on (the page's by default): it must match what is
 * behind the view, or the crossing shows as a box.
 */
export function FilmSwap({ cues, dur = 0.4, className, ground = "bg-sol-bg", render }: { cues: readonly number[]; dur?: number; className?: string; ground?: string; render: (step: number) => ReactNode }) {
  // step + k while crossing (k in (0, 1), quantised), a whole step at rest.
  const v = useFilmTime((t) => {
    const step = cues.filter((c) => t >= c).length;
    if (step === 0) return 0;
    const k = Math.round(fade(clamp((t - cues[step - 1]) / dur)) * 24) / 24;
    return k >= 1 ? step : step - 1 + Math.max(k, 1 / 48);
  });
  const base = Math.floor(v);
  const k = v - base;
  const [hBase, measureBase] = useLayoutHeight();
  const [hNext, measureNext] = useLayoutHeight();
  return (
    <div className={`grid ${className ?? ""}`} style={k > 0 && hBase !== null && hNext !== null ? { height: hBase + (hNext - hBase) * k, overflow: "clip" } : undefined}>
      <div ref={measureBase} className="col-start-1 row-start-1 self-start">{render(base)}</div>
      {k > 0 && (
        <div ref={measureNext} className={`col-start-1 row-start-1 self-start ${ground}`} style={{ opacity: k }} aria-hidden>
          {render(base + 1)}
        </div>
      )}
    </div>
  );
}
