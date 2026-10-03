"use client";

/** What the film driver writes beyond styles: typed text, and veils (see filmClock.ts for the rest of the clock). */

import { useContext, useLayoutEffect, useRef, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { SessionCardView } from "@/components/inbox/SessionCardView";
import { FilmClockContext, fly, POSTER_FRAME, useFilmTime } from "./filmClock";
import { clamp, dip, fade } from "./timeline";

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

/**
 * Its children, faded out at `out` and back in at `back` (film seconds): a
 * status chip that clears while an agent waits on a reply and returns when it
 * works again. It stays laid out throughout, so nothing beside it moves.
 */
export function FilmDip({ out, back, dur = 0.3, children }: { out: number; back: number; dur?: number; children: ReactNode }) {
  const o = useFilmTime((t) => Math.round(dip(t, out, back, dur) * 40) / 40);
  return <span className="inline-flex" style={{ opacity: o }}>{children}</span>;
}

/** A wash of the page colour over a surface (a `scrim` region), faded by its beats: it steps the surface back while the camera frames something else. */
export function Veil({ id }: { id: string }) {
  return <div {...fly(id)} aria-hidden className="pointer-events-none h-full w-full bg-sol-bg/75" />;
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
 *
 * Its height and opacity are written to the DOM on every film tick, to the
 * whole px, from the content's height read in that same tick: React renders
 * only as it mounts, starts or stops moving, and unmounts.
 */
export function FilmGrow({ at, until = Infinity, dur = 0.5, children }: { at: number; until?: number; dur?: number; children: ReactNode }) {
  const clock = useContext(FilmClockContext);
  const open = (t: number) => fade(clamp((t - at) / dur)) * (1 - fade(clamp((t - until) / dur)));
  // -1 not mounted, 0 opening or closing, 1 laid out as normal.
  const phase = useFilmTime((t) => (t < at || t >= until + dur ? -1 : open(t) >= 1 ? 1 : 0));
  const wrap = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const apply = () => {
    const w = wrap.current;
    if (!w || !inner.current) return;
    const k = open(clock.get());
    if (phase !== 0 || k >= 1) {
      w.style.height = "";
      w.style.opacity = "";
      w.style.overflow = "";
      return;
    }
    w.style.overflow = "clip";
    w.style.height = `${Math.round(inner.current.offsetHeight * k)}px`;
    w.style.opacity = String(Math.round(k * 1000) / 1000);
  };
  useLayoutEffect(apply);
  useLayoutEffect(() => (phase === 0 ? clock.subscribe(apply) : undefined));
  if (phase < 0) return null;
  // flow-root keeps the children's margins inside the measured box, so the height it opens to is the height it rests at.
  return (
    <div ref={wrap} style={phase === 0 ? { height: 0, opacity: 0, overflow: "clip" } : undefined}>
      <div ref={inner} className="flow-root">{children}</div>
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
 *
 * A crossing takes `dur`, or less when the next cue comes sooner, so it is
 * always whole before the next one starts. Both states' heights are read in
 * the tick that draws them, and the height and the new state's opacity are
 * written to the DOM on every film tick: React renders only as a crossing
 * starts and ends.
 */
export function FilmSwap({ cues, dur = 0.4, className, ground = "bg-sol-bg", render }: { cues: readonly number[]; dur?: number; className?: string; ground?: string; render: (step: number) => ReactNode }) {
  const clock = useContext(FilmClockContext);
  /** The settled step at t, and how far the next one has come in over it (0 at rest). */
  const at = (t: number) => {
    const step = cues.filter((c) => t >= c).length;
    if (step === 0) return { base: 0, k: 0 };
    const span = Math.min(dur, (cues[step] ?? Infinity) - cues[step - 1]);
    const k = fade(clamp((t - cues[step - 1]) / span));
    return k >= 1 ? { base: step, k: 0 } : { base: step - 1, k: Math.max(k, 1e-3) };
  };
  const phase = useFilmTime((t) => {
    const { base, k } = at(t);
    return base * 2 + (k > 0 ? 1 : 0);
  });
  const base = phase >> 1;
  const crossing = (phase & 1) === 1;
  const grid = useRef<HTMLDivElement>(null);
  const settled = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLDivElement>(null);
  const apply = () => {
    const g = grid.current;
    if (!g) return;
    const now = at(clock.get());
    // Between a tick and the render it asks for, the slots still show the last phase: wait for it.
    if (!crossing || now.base !== base || now.k <= 0 || !settled.current || !next.current) {
      g.style.height = "";
      g.style.overflow = "";
      return;
    }
    const [h0, h1] = [settled.current.offsetHeight, next.current.offsetHeight];
    g.style.overflow = "clip";
    g.style.height = `${Math.round(h0 + (h1 - h0) * now.k)}px`;
    next.current.style.opacity = String(Math.round(now.k * 1000) / 1000);
  };
  useLayoutEffect(apply);
  useLayoutEffect(() => (crossing ? clock.subscribe(apply) : undefined));
  return (
    <div ref={grid} className={`grid ${className ?? ""}`}>
      <div ref={settled} className="col-start-1 row-start-1 self-start">{render(base)}</div>
      {crossing && (
        <div ref={next} className={`col-start-1 row-start-1 self-start ${ground}`} style={{ opacity: 0 }} aria-hidden>
          {render(base + 1)}
        </div>
      )}
    </div>
  );
}
