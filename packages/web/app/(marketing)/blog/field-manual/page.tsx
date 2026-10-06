"use client";

import { BlogNav, P, SOL } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { CHAPTERS, PARTS, SERIES_SLUG, chapterImage, type ChapterPart } from "./chapters";
import { BackLink, ChapterCard, SERIES_CSS, rise } from "./parts";

export default function FieldManualHub() {
  const post = getPost(SERIES_SLUG);
  useRouteMeta(`/blog/${SERIES_SLUG}`);
  const minutes = CHAPTERS.reduce((n, c) => n + c.readingMinutes, 0);
  let card = 0;

  return (
    <main className="min-h-screen w-full overflow-x-clip" style={{ backgroundColor: SOL.base3 }}>
      <style>{SERIES_CSS}</style>
      <BlogNav />

      <header className="max-w-6xl mx-auto px-6 pt-14 pb-16 grid lg:grid-cols-[1fr_1.1fr] gap-12 items-center">
        <div>
          <BackLink href="/blog">Blog</BackLink>
          <div className="fm-rise mt-8 font-mono text-xs font-bold" style={{ color: SOL.orange, ...rise(0) }}>
            A series in {CHAPTERS.length} chapters
          </div>
          <h1 className="fm-rise mt-3 text-4xl md:text-5xl font-bold leading-[1.08] tracking-tight font-mono" style={{ color: SOL.base03, ...rise(1) }}>
            {post?.title}
          </h1>
          <p className="fm-rise mt-6 text-xl leading-relaxed" style={{ color: SOL.base00, ...rise(2) }}>{post?.dek}</p>
          <div className="fm-rise mt-6 flex flex-wrap items-center gap-3 font-mono text-sm" style={{ color: SOL.base1, ...rise(3) }}>
            <span>{post?.author}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel}</time>
            <span aria-hidden>&middot;</span>
            <span>{minutes} min across the series</span>
          </div>
        </div>
        <div className="fm-rise rounded-2xl border overflow-hidden shadow-2xl" style={{ borderColor: SOL.base2, ...rise(2) }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={chapterImage("inbox-hero.webp")} alt="The codecast inbox beside an open conversation" className="w-full block" />
        </div>
      </header>

      <section className="max-w-2xl mx-auto px-6 pb-8">
        <P>
          Running one coding agent is a conversation. Running thirty is a job, and most of it is overhead: finding the
          session that is waiting on you, remembering which agent owns which area, carrying a half-finished thought from
          Claude to Codex, noticing that a check went red at two in the morning. Codecast exists to take that overhead
          away. This manual walks through how, one piece at a time, with the real product on every page.
        </P>
        <P>
          Part one covers the operating model: the org your agents report into, the inbox that sorts every session by
          who acts next, and how a live conversation moves from one agent to another without losing a word. Part two is
          ten features that exist nowhere else, each one there because running agents at volume broke something. Read it
          in order or jump to the chapter you need; each one stands on its own.
        </P>
      </section>

      {(Object.keys(PARTS) as ChapterPart[]).map((part) => (
        <section key={part} className="max-w-6xl mx-auto px-6 pt-12 pb-6">
          <div className="pb-6 mb-8" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
            <div className="font-mono text-xs font-bold" style={{ color: SOL.base1 }}>{PARTS[part].label}</div>
            <h2 className="mt-2 text-3xl md:text-4xl font-bold font-mono tracking-tight" style={{ color: SOL.base03 }}>{PARTS[part].title}</h2>
            <p className="mt-3 text-lg leading-relaxed max-w-2xl" style={{ color: SOL.base00 }}>{PARTS[part].dek}</p>
          </div>
          <div className={`grid gap-6 ${part === "operating-model" ? "md:grid-cols-3" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
            {CHAPTERS.filter((c) => c.part === part).map((c) => (
              <ChapterCard key={c.slug} chapter={c} index={card++} />
            ))}
          </div>
        </section>
      ))}

      <div className="pb-24" />
    </main>
  );
}
