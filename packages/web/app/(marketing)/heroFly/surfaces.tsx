"use client";

/**
 * The fly-through's world: every surface with its regions, the chapter parts
 * placed into them, the flyers and arcs between surfaces, and the world
 * label. Surfaces, regions and cues come from world.ts; what fills a region
 * comes from the chapters (chapters/README.md). Initial inline styles come
 * from `frame(POSTER_T)`, so the prerender is the poster frame and hydration
 * matches it.
 */

import { Suspense, type CSSProperties, type ComponentType } from "react";
import { LogoIcon } from "@/components/Logo";
import { PhoneFrame } from "../productMocks";
import type { ChapterPart, HeroChapter, PartProps } from "./chapters/contract";
import { fly, SurfaceContext } from "./filmClock";
import { ARCS, FLYERS } from "./motion";
import { HeroPartBoundary } from "./sandbox";
import { LABEL_3W, SURFACES, type ArcPath, type Region, type RegionKey, type Surface } from "./world";

const px = (n: number) => `${Math.round(n * 1000) / 1000}px`;

type Placed = ChapterPart & { chapter: string };

function RegionSlot({ k, region, parts, now }: { k: RegionKey; region: Region; parts: Placed[]; now: number }) {
  return (
    <div
      data-region={k}
      style={{
        position: "absolute",
        left: region.x,
        top: region.y,
        width: region.w,
        height: region.h,
        display: "flex",
        flexDirection: "column",
        justifyContent: region.anchor === "bottom" ? "flex-end" : "flex-start",
        overflow: "hidden",
      }}
    >
      {parts.map((p) => (
        <HeroPartBoundary key={`${p.chapter}.${p.key}`} name={`${p.chapter}.${p.key}`}>
          <Suspense fallback={null}>
            <p.Component now={now} />
          </Suspense>
        </HeroPartBoundary>
      ))}
    </div>
  );
}

function SurfaceMount({ s, parts, now }: { s: Surface; parts: Placed[]; now: number }) {
  const face: CSSProperties = { position: "absolute", inset: 0, backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", borderRadius: s.radius, overflow: "hidden" };
  const regions = Object.entries(s.regions).map(([name, region]) => {
    const k = `${s.id}.${name}` as RegionKey;
    return <RegionSlot key={k} k={k} region={region} parts={parts.filter((p) => p.region === k)} now={now} />;
  });
  return (
    <div
      {...fly(`mount:${s.id}`, {
        position: "absolute",
        left: -s.w / 2,
        top: -s.h / 2,
        width: s.w,
        height: s.h,
        transformStyle: "preserve-3d",
        transform: `translate3d(${px(s.pos[0])}, ${px(s.pos[1])}, ${px(s.pos[2])}) rotateX(${s.rot[0]}deg) rotateY(${s.rot[1]}deg) rotateZ(${s.rot[2]}deg)`,
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
          background: "radial-gradient(closest-side, rgba(0,43,54,0.16), rgba(0,43,54,0.07) 60%, rgba(0,43,54,0) 100%)",
        })}
      />
      <div {...fly(`card:${s.id}`, { position: "absolute", inset: 0, transformStyle: "preserve-3d" })}>
        <SurfaceContext.Provider value={s.id}>
          {s.frame === "phone" ? (
            <div style={face}>
              {/* Regions on the phone are measured from the screen's top-left, under the notch. */}
              <PhoneFrame className="h-full !shadow-none" screenClassName="dark relative h-full">
                <div className="relative bg-sol-bg text-sol-text" style={{ height: s.h - 48 }}>{regions}</div>
              </PhoneFrame>
            </div>
          ) : (
            <div className="bg-sol-bg text-sol-text" style={{ ...face, border: "1px solid var(--sol-bg-highlight)", boxShadow: "0 30px 60px -30px rgba(0,43,54,0.35)" }}>
              {regions}
            </div>
          )}
        </SurfaceContext.Provider>
        <div
          style={{ ...face, transform: "rotateX(180deg)", border: "1px solid var(--sol-bg-highlight)" }}
          className="flex flex-col items-center justify-center gap-3 bg-sol-bg-alt font-mono"
        >
          <LogoIcon size={34} />
          <span className="text-[13px] text-sol-text-dim">{s.back}</span>
        </div>
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
  const d = `M ${ax - x0} ${ay - y0} Q ${(ax + bx) / 2 - x0} ${Math.min(ay, by) - y0 - 170} ${bx - x0} ${by - y0}`;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ position: "absolute", left: 0, top: 0, overflow: "visible", transform: `translate3d(${px(x0)}, ${px(y0)}, ${px(z)})` }}
    >
      <path {...fly(a.id, { strokeDasharray: 1, strokeDashoffset: 1 })} d={d} pathLength={1} fill="none" stroke={a.color} strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

/** Everything inside the camera: backdrop, surfaces, flyers. The driver writes styles to it; React renders it again only when chapters load. */
export function World({ chapters, now }: { chapters: HeroChapter[]; now: number }) {
  const parts: Placed[] = chapters
    .flatMap((c) => c.parts.map((p) => ({ ...p, chapter: c.id })))
    .sort((a, b) => a.order - b.order);
  const flyers: Record<string, ComponentType<PartProps>> = Object.assign({}, ...chapters.map((c) => c.flyers ?? {}));
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: -6000,
          top: -4600,
          width: 12000,
          height: 9200,
          transform: "translateZ(-420px)",
          backgroundColor: "var(--sol-bg)",
          backgroundImage: "radial-gradient(var(--sol-bg-highlight) 1.4px, transparent 1.6px)",
          backgroundSize: "32px 32px",
        }}
      />
      {SURFACES.map((s) => <SurfaceMount key={s.id} s={s} parts={parts.filter((p) => p.region.startsWith(`${s.id}.`))} now={now} />)}
      {ARCS.map((a) => <Arc key={a.id} a={a} />)}
      {FLYERS.map((f) => {
        const Flyer = flyers[f.id];
        return (
          <div key={f.id} {...fly(f.id, { position: "absolute", left: 0, top: 0 })}>
            {Flyer && (
              <HeroPartBoundary name={f.id}>
                <Flyer now={now} />
              </HeroPartBoundary>
            )}
          </div>
        );
      })}
      <div
        {...fly("label3w", { position: "absolute", left: 0, top: 0, transform: `translate3d(${px(LABEL_3W.pos[0])}, ${px(LABEL_3W.pos[1])}, ${px(LABEL_3W.pos[2])})` })}
      >
        <span className="inline-block -translate-x-1/2 whitespace-nowrap font-mono text-[44px] font-bold text-sol-text/80">3 weeks later</span>
      </div>
    </>
  );
}
