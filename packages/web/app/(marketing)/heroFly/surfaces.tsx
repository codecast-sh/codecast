"use client";

/**
 * The fly-through's world: every surface with its regions, the chapter parts
 * placed into them, the flyers and arcs between surfaces, and the world
 * label. Surfaces, regions and cues come from world.ts; what fills a region
 * comes from the chapters (chapters/README.md). Initial inline styles come
 * from `frame(POSTER_T)`, so the prerender is the poster frame and hydration
 * matches it.
 */

import { memo, startTransition, Suspense, useContext, useState, type CSSProperties, type ComponentType, type ReactNode } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { EntityFixtureContext } from "@/lib/entityDisplay";
import { PhoneFrame } from "../productMocks";
import type { ChapterPart, HeroChapter, PartProps } from "./chapters/contract";
import { createFilmClock, FilmClockContext, fly, useFilmTime } from "./filmClock";
import { entityStage, ENTITY_STAGES } from "./fixtures";
import { ARCS, FLYERS } from "./motion";
import { isLive, SEAM_GHOST } from "./timeline";
import { HeroPartBoundary } from "./sandbox";
import { LABEL_3W, SCENES, SURFACES, type ArcPath, type Region, type RegionKey, type Surface, type SurfaceId } from "./world";

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;

/** A window floating off the stage: a hairline, a close soft shadow and a far one, so it never reads as pasted onto the cream. */
const FACE_SHADOW = "0 1px 0 rgba(0,43,54,0.06), 0 24px 48px -20px rgba(0,43,54,0.28), 0 60px 120px -40px rgba(0,43,54,0.22)";

type Placed = ChapterPart & { chapter: string };

/**
 * Film second from which a chapter's views are mounted: the start of the
 * chapter two before it, early enough for every cue it shows and every
 * resting state it must have in place before its window is shown.
 */
const MOUNT_FROM: Record<string, number> = Object.fromEntries(SCENES.map((sc, i) => [sc.id, SCENES[Math.max(0, i - 2)].start]));

/**
 * Mounts a chapter's views once the film comes near it and keeps them
 * mounted, so the views of a chapter a minute away cost nothing while the
 * opening plays, and the chapters arrive one by one rather than in one commit.
 * Crossing into reach mounts them in a transition, off the clock tick that
 * crossed it, so no animation frame carries a chapter's first render.
 */
function NearChapter({ chapter, children }: { chapter: string; children: ReactNode }) {
  const from = MOUNT_FROM[chapter] ?? 0;
  const near = useFilmTime((t) => t >= from);
  const [seen, setSeen] = useState(near);
  useWatchEffect(() => {
    if (near && !seen) startTransition(() => setSeen(true));
  }, [near, seen]);
  return seen ? children : null;
}

function RegionSlot({ k, region, parts, now }: { k: RegionKey; region: Region; parts: Placed[]; now: number }) {
  // A region that was empty in the prerender (the poster's conversation pane) fades in when its views arrive, if its window is on
  // screen then: a page-load event, on the page's clock. Views that arrive while their window is away simply wait there.
  const clock = useContext(FilmClockContext);
  const [emptyAtFirst] = useState(parts.length === 0);
  const [arrivedInView, setArrivedInView] = useState<boolean | null>(null);
  if (emptyAtFirst && parts.length > 0 && arrivedInView === null) setArrivedInView(isLive(k.split(".")[0] as SurfaceId, clock.get(), clock.view.mobile, clock.view.side));
  const bottom = region.anchor === "bottom";
  return (
    <div
      data-region={k}
      className={arrivedInView ? "hf-in" : undefined}
      style={{
        position: "absolute",
        left: region.x,
        top: region.y,
        width: region.w,
        height: region.h,
        display: "flex",
        flexDirection: "column",
        justifyContent: bottom ? "flex-end" : "flex-start",
        // clip, not hidden: a hidden box is a scroll container, and a real
        // view's scrollIntoView or focus would scroll the film inside it.
        overflow: "clip",
        // A region overlaps others (the card over the conversation): its own box takes no clicks, only the views in it (HeroFlythrough's [data-region]>* rule).
        pointerEvents: "none",
      }}
    >
      {parts.map((p) => (
        <HeroPartBoundary key={`${p.chapter}.${p.key}`} name={`${p.chapter}.${p.key}`}>
          <NearChapter chapter={p.chapter}>
            <Suspense fallback={null}>
              <p.Component now={now} />
            </Suspense>
          </NearChapter>
        </HeroPartBoundary>
      ))}
    </div>
  );
}

const regionsOf = (s: Surface, parts: Placed[], now: number) =>
  Object.entries(s.regions).map(([name, region]) => {
    const k = `${s.id}.${name}` as RegionKey;
    return <RegionSlot key={k} k={k} region={region} parts={parts.filter((p) => p.region === k)} now={now} />;
  });

const WINDOW_BORDER = "1px solid color-mix(in srgb, var(--sol-text) 10%, transparent)";

/** The clock the seam's copy runs on: the film's first instant, held. */
const OPENING_CLOCK = createFilmClock(0);

/** The box a window's seam cover clears: the union of its pane regions (timeline.ts SEAM_GHOST.pane). */
function paneBox(s: Surface): CSSProperties {
  const rs = SEAM_GHOST.pane.map((k) => s.regions[k]).filter(Boolean);
  const [x0, y0] = [Math.min(...rs.map((r) => r.x)), Math.min(...rs.map((r) => r.y))];
  const [x1, y1] = [Math.max(...rs.map((r) => r.x + r.w)), Math.max(...rs.map((r) => r.y + r.h))];
  return { position: "absolute", left: x0, top: y0, width: x1 - x0, height: y1 - y0, pointerEvents: "none" };
}

/**
 * The seam's copy of an opening window (timeline.ts SEAM_GHOST): first a
 * cover in the page's cream clears the live conversation pane, as the app
 * does when it opens another session; then the same regions and views, on a
 * clock held at 0, fade in over the live window's content inside its face (so
 * the face's corners clip it), so the last frame is the first. The copy has
 * no ground of its own: outside the pane the live window already shows what
 * it shows, and inside it the copy lands on the cleared cover, so no frame
 * shows two versions of anything. Its elements carry `data-fly` like the live
 * ones; the driver keeps them apart by the `data-fly-ghost` box and writes
 * them frame(0). Mounted in a transition a few seconds before it shows,
 * unmounted once the film wraps.
 */
function SeamGhost({ s, parts, now }: { s: Surface; parts: Placed[]; now: number }) {
  const near = useFilmTime((t) => t >= SEAM_GHOST.mount);
  const [on, setOn] = useState(false);
  useWatchEffect(() => {
    if (near !== on) startTransition(() => setOn(near));
  }, [near, on]);
  return (
    <>
      <div {...fly(`cover:${s.id}`, paneBox(s))} aria-hidden className="bg-sol-bg" />
      <div {...fly(`ghost:${s.id}`, { position: "absolute", inset: 0, pointerEvents: "none" })} aria-hidden className="text-sol-text">
        {on && (
          <div data-fly-ghost className="absolute inset-0">
            <FilmClockContext.Provider value={OPENING_CLOCK}>
              <FilmEntities>{regionsOf(s, parts, now)}</FilmEntities>
            </FilmClockContext.Provider>
          </div>
        )}
      </div>
    </>
  );
}

function SurfaceMount({ s, parts, now }: { s: Surface; parts: Placed[]; now: number }) {
  const face: CSSProperties = { position: "absolute", inset: 0, borderRadius: s.radius, overflow: "clip" };
  const regions = regionsOf(s, parts, now);
  return (
    <div
      {...fly(`mount:${s.id}`, {
        position: "absolute",
        left: -s.w / 2,
        top: -s.h / 2,
        width: s.w,
        height: s.h,
        transformStyle: "preserve-3d",
        // The surface's zoom last, so its own px (regions, beats) are scaled with it, as localToWorld does.
        transform: `translate3d(${px(s.pos[0])}, ${px(s.pos[1])}, ${px(s.pos[2])}) rotateX(${s.rot[0]}deg) rotateY(${s.rot[1]}deg) rotateZ(${s.rot[2]}deg)${s.zoom ? ` scale3d(${s.zoom}, ${s.zoom}, ${s.zoom})` : ""}`,
      })}
    >
      <div
        {...fly(`shadow:${s.id}`, {
          position: "absolute",
          left: "-6%",
          top: "2%",
          width: "112%",
          height: "112%",
          borderRadius: s.radius * 2,
          background: "radial-gradient(closest-side, rgba(0,43,54,0.22), rgba(0,43,54,0.08) 60%, rgba(0,43,54,0) 100%)",
        })}
      />
      <div {...fly(`card:${s.id}`, { position: "absolute", inset: 0, transformStyle: "preserve-3d" })}>
        {s.frame === "phone" ? (
          <div {...fly(`face:${s.id}`, face)}>
            {/* Regions on the phone are measured from the screen's top-left, under the notch. */}
            <PhoneFrame className="h-full !shadow-none" screenClassName="relative h-full">
              <div className="relative bg-sol-bg text-sol-text" style={{ height: s.h - 48 }}>{regions}</div>
            </PhoneFrame>
          </div>
        ) : (
          <div {...fly(`face:${s.id}`, { ...face, border: WINDOW_BORDER, boxShadow: FACE_SHADOW })} className="bg-sol-bg text-sol-text">
            {regions}
            {(SEAM_GHOST.surfaces as readonly string[]).includes(s.id) && <SeamGhost s={s} parts={parts} now={now} />}
          </div>
        )}
      </div>
    </div>
  );
}

function Arc({ a }: { a: ArcPath }) {
  const [ax, ay] = a.from;
  const [bx, by] = a.to;
  const x0 = Math.min(ax, bx) - 20;
  const y0 = Math.min(ay, by) - 200;
  const w = Math.abs(ax - bx) + 40;
  const h = Math.abs(ay - by) + 240;
  const z = (a.from[2] + a.to[2]) / 2;
  const d = `M ${ax - x0} ${ay - y0} Q ${(ax + bx) / 2 - x0} ${Math.min(ay, by) - y0 - (a.apex ?? 170)} ${bx - x0} ${by - y0}`;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", transform: `translate3d(${px(x0)}, ${px(y0)}, ${px(z)})` }}
    >
      <path {...fly(a.id, { strokeDasharray: 1, strokeDashoffset: 1 })} d={d} pathLength={1} fill="none" stroke={a.color} strokeWidth={5} strokeLinecap="round" />
      <circle {...fly(`${a.id}.dot`)} cx={bx - x0} cy={by - y0} r={7} fill={a.color} />
      <circle {...fly(`${a.id}.ring`, { transformBox: "fill-box", transformOrigin: "center" })} cx={bx - x0} cy={by - y0} r={22} fill="none" stroke={a.color} strokeWidth={3} />
    </svg>
  );
}

/** Entity pills and cards read the fixtures in force at film time; only their consumers re-render when the stage turns. */
function FilmEntities({ children }: { children: ReactNode }) {
  const stage = useFilmTime(entityStage);
  return <EntityFixtureContext.Provider value={ENTITY_STAGES[stage]}>{children}</EntityFixtureContext.Provider>;
}

/**
 * Everything inside the camera: surfaces, flyers, arcs. There is no backdrop: the page itself is the ground. The driver writes
 * styles to it; React renders it again only when chapters load (memo: the
 * hero's own state, its chapter, play and phone flags, never reaches it).
 */
export const World = memo(function World({ chapters, now }: { chapters: HeroChapter[]; now: number }) {
  const parts: Placed[] = chapters
    .flatMap((c) => c.parts.map((p) => ({ ...p, chapter: c.id })))
    .sort((a, b) => a.order - b.order);
  const flyers: Record<string, ComponentType<PartProps>> = Object.assign({}, ...chapters.map((c) => c.flyers ?? {}));
  return (
    <FilmEntities>
      {SURFACES.map((s) => <SurfaceMount key={s.id} s={s} parts={parts.filter((p) => p.region.startsWith(`${s.id}.`))} now={now} />)}
      {ARCS.map((a) => <Arc key={a.id} a={a} />)}
      {FLYERS.map((f) => {
        const Flyer = flyers[f.id];
        return (
          <div key={f.id} {...fly(f.id, { position: "absolute", left: 0, top: 0 })}>
            {Flyer && (
              <HeroPartBoundary name={f.id}>
                <NearChapter chapter={f.id.split(".")[0]}>
                  <Flyer now={now} />
                </NearChapter>
              </HeroPartBoundary>
            )}
          </div>
        );
      })}
      <div
        {...fly("label3w", { position: "absolute", left: 0, top: 0, transform: `translate3d(${px(LABEL_3W.pos[0])}, ${px(LABEL_3W.pos[1])}, ${px(LABEL_3W.pos[2])})` })}
      >
        <span className="inline-block -translate-x-1/2 whitespace-nowrap font-mono text-[34px] font-semibold text-sol-text-muted">3 weeks later</span>
      </div>
    </FilmEntities>
  );
});
