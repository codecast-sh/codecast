"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../blogChrome";
import { CHAPTERS, PARTS, SERIES_SLUG, SERIES_TITLE, chapterHref, chapterImage, type Chapter } from "./chapters";

export const accentOf = (c: Chapter) => SOL[c.color];
export const chapterNumber = (c: Chapter) => String(CHAPTERS.indexOf(c) + 1).padStart(2, "0");

// One staggered rise on load; reduced motion shows everything at rest.
export const SERIES_CSS = `
.fm-rise{opacity:0;transform:translateY(14px);animation:fm-rise .7s cubic-bezier(.2,.7,.2,1) var(--at,0s) forwards}
@keyframes fm-rise{to{opacity:1;transform:none}}
.fm-card{transition:transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s,border-color .25s}
.fm-card:hover{transform:translateY(-3px);border-color:var(--c);box-shadow:0 18px 36px -24px var(--c)}
.fm-card:hover .fm-img{transform:scale(1.04)}
@media (prefers-reduced-motion:reduce){.fm-rise{opacity:1;transform:none;animation:none}.fm-card,.fm-img{transition:none!important}}
`;

export const rise = (i: number) => ({ "--at": `${0.06 + i * 0.06}s` }) as CSSProperties;

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium" style={{ color: SOL.yellow }}>
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
      </svg>
      {children}
    </Link>
  );
}

/** A chapter card for the hub and the end of each chapter. */
export function ChapterCard({ chapter, index, compact = false }: { chapter: Chapter; index: number; compact?: boolean }) {
  const c = accentOf(chapter);
  return (
    <Link
      href={chapterHref(chapter.slug)}
      className="fm-card fm-rise group flex flex-col rounded-2xl border overflow-hidden"
      style={{ "--c": c, borderColor: SOL.base2, backgroundColor: SOL.base3, ...rise(index) } as CSSProperties}
    >
      {!compact && (
        <div className="aspect-[16/9] overflow-hidden" style={{ backgroundColor: SOL.base2 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={chapterImage(chapter.cover)} alt="" loading="lazy" className="fm-img w-full h-full object-cover object-left-top transition-transform duration-500 ease-out" />
        </div>
      )}
      <div className="p-5 flex-1 flex flex-col">
        <div className="flex items-baseline gap-3">
          <span className="font-mono font-bold text-3xl leading-none" style={{ color: c }}>{chapterNumber(chapter)}</span>
          <span className="font-mono text-xs font-bold" style={{ color: c }}>{chapter.kicker}</span>
        </div>
        <div className="mt-3 font-mono font-bold text-[17px] leading-snug tracking-tight" style={{ color: SOL.base03 }}>{chapter.title}</div>
        {!compact && <p className="mt-2 text-[14.5px] leading-relaxed" style={{ color: SOL.base00 }}>{chapter.dek}</p>}
        <div className="mt-auto pt-4 font-mono text-xs" style={{ color: SOL.base1 }}>{chapter.readingMinutes} min read</div>
      </div>
    </Link>
  );
}

/** Every chapter grouped by part, with the current one marked; the rail and the hub both read it. */
export function SeriesContents({ current }: { current?: Chapter }) {
  return (
    <nav className="font-mono text-[13px]">
      <Link href={`/blog/${SERIES_SLUG}`} className="block font-bold mb-3" style={{ color: SOL.base03 }}>{SERIES_TITLE}</Link>
      {(Object.keys(PARTS) as (keyof typeof PARTS)[]).map((part) => (
        <div key={part} className="mb-4">
          <div className="text-[11px] font-bold mb-1.5" style={{ color: SOL.base1 }}>{PARTS[part].label}: {PARTS[part].title}</div>
          {CHAPTERS.filter((c) => c.part === part).map((c) => {
            const on = c === current;
            return (
              <Link
                key={c.slug}
                href={chapterHref(c.slug)}
                className="flex gap-2.5 py-1 px-2 -mx-2 rounded-md transition-colors"
                style={{ color: on ? SOL.base03 : SOL.base00, backgroundColor: on ? `color-mix(in srgb, ${accentOf(c)} 14%, transparent)` : undefined }}
              >
                <span className="font-bold w-5 shrink-0" style={{ color: accentOf(c) }}>{chapterNumber(c)}</span>
                {c.kicker}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
