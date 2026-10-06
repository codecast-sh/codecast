"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { BlogNav, SOL } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { CHAPTERS, PARTS, SERIES_SLUG, SERIES_TITLE, chapterHref, getChapter } from "./chapters";
import { getChapterContent } from "./chapterContent";
import { ChapterMarkdown, chapterSections } from "./markdown";
import { BackLink, ChapterCard, SERIES_CSS, SeriesContents, accentOf, chapterNumber, rise } from "./parts";

export default function ChapterPage() {
  const params = useParams<{ chapter: string }>();
  const chapter = getChapter(params.chapter ?? "");
  const source = chapter ? getChapterContent(chapter.slug) ?? "" : "";
  useRouteMeta(chapterHref(params.chapter ?? ""));

  if (!chapter) {
    return (
      <main className="min-h-screen w-full" style={{ backgroundColor: SOL.base3 }}>
        <BlogNav />
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <h1 className="text-2xl font-bold font-mono mb-3" style={{ color: SOL.base03 }}>No such chapter</h1>
          <Link href={`/blog/${SERIES_SLUG}`} className="underline" style={{ color: SOL.blue }}>Back to {SERIES_TITLE}</Link>
        </div>
      </main>
    );
  }

  const accent = accentOf(chapter);
  const index = CHAPTERS.indexOf(chapter);
  const next = CHAPTERS[index + 1];
  const prev = CHAPTERS[index - 1];
  const sections = chapterSections(source);

  return (
    <main className="min-h-screen w-full overflow-x-clip" style={{ backgroundColor: SOL.base3 }}>
      <style>{SERIES_CSS}</style>
      <BlogNav />

      <div className="max-w-6xl mx-auto px-6 pt-14 pb-24 xl:grid xl:grid-cols-[minmax(0,1fr)_15rem] xl:gap-16">
        <article className="max-w-2xl mx-auto w-full min-w-0">
          <BackLink href={`/blog/${SERIES_SLUG}`}>{SERIES_TITLE}</BackLink>

          <header className="mt-8 mb-12">
            <div className="fm-rise flex items-end gap-5 pb-5 mb-6" style={{ borderBottom: `3px solid ${accent}`, ...rise(0) }}>
              <span className="font-mono font-bold leading-[0.8] tracking-tighter text-[88px] md:text-[120px]" style={{ color: accent }}>
                {chapterNumber(chapter)}
              </span>
              <span className="font-mono text-sm font-bold pb-2" style={{ color: accent }}>
                {PARTS[chapter.part].label} · {chapter.kicker}
              </span>
            </div>
            <h1 className="fm-rise text-3xl md:text-[42px] font-bold leading-[1.12] tracking-tight font-mono" style={{ color: SOL.base03, ...rise(1) }}>
              {chapter.title}
            </h1>
            <p className="fm-rise mt-5 text-xl leading-relaxed" style={{ color: SOL.base00, ...rise(2) }}>{chapter.dek}</p>
            <div className="fm-rise mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1, ...rise(3) }}>
              <span>the codecast team</span>
              <span aria-hidden>&middot;</span>
              <time dateTime="2026-10-06">October 6, 2026</time>
              <span aria-hidden>&middot;</span>
              <span>{chapter.readingMinutes} min read</span>
            </div>
          </header>

          <ChapterMarkdown source={source} accent={accent} />

          <div className="mt-16 pt-10 grid sm:grid-cols-2 gap-4" style={{ borderTop: `1px solid ${SOL.base2}` }}>
            {prev ? <div><div className="font-mono text-xs mb-2" style={{ color: SOL.base1 }}>Previous</div><ChapterCard chapter={prev} index={0} compact /></div> : <div />}
            {next && <div><div className="font-mono text-xs mb-2" style={{ color: SOL.base1 }}>Next</div><ChapterCard chapter={next} index={1} compact /></div>}
          </div>
          <div className="mt-8 font-mono text-sm">
            <Link href={`/blog/${SERIES_SLUG}`} style={{ color: SOL.blue }} className="underline underline-offset-2">All {CHAPTERS.length} chapters</Link>
          </div>
        </article>

        <aside className="hidden xl:block">
          <div className="sticky top-24 max-h-[calc(100vh-7rem)] overflow-y-auto pr-1">
            {sections.length > 1 && (
              <div className="mb-8 font-mono text-[13px]">
                <div className="text-[11px] font-bold mb-2" style={{ color: SOL.base1 }}>In this chapter</div>
                {sections.map((s) => (
                  <a key={s.id} href={`#${s.id}`} className="block py-1 leading-snug hover:underline" style={{ color: SOL.base00 }}>{s.title}</a>
                ))}
              </div>
            )}
            <SeriesContents current={chapter} />
          </div>
        </aside>
      </div>
    </main>
  );
}

