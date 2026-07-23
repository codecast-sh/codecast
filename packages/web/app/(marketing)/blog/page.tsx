"use client";

import Link from "next/link";
import { BlogNav, BlogFooter, SOL } from "./blogChrome";
import { usePageMeta } from "../pageMeta";
import { POSTS } from "./posts";

export default function BlogIndexPage() {
  usePageMeta(
    "Blog — Codecast",
    "Notes on agent memory, attribution, and steering coding agents at team scale.",
  );

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav />

      <section className="max-w-3xl mx-auto px-6 pt-20 pb-10">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight font-mono" style={{ color: SOL.base03 }}>
          Blog
        </h1>
        <p className="mt-4 text-lg leading-relaxed" style={{ color: SOL.base00 }}>
          Notes on agent memory, attribution, and steering coding agents at team scale.
        </p>
      </section>

      <section className="max-w-3xl mx-auto px-6 pb-24">
        <ul className="divide-y" style={{ borderColor: SOL.base2 }}>
          {POSTS.map((post) => (
            <li key={post.slug} className="py-8 first:pt-0">
              <Link href={`/blog/${post.slug}`} className="group block">
                <div className="flex items-center gap-3 mb-2 font-mono text-xs" style={{ color: SOL.base1 }}>
                  <time dateTime={post.date}>{post.dateLabel}</time>
                  <span aria-hidden>&middot;</span>
                  <span>{post.readingMinutes} min read</span>
                </div>
                <h2
                  className="text-2xl font-bold font-mono tracking-tight transition-colors group-hover:text-[#cb4b16]"
                  style={{ color: SOL.base03 }}
                >
                  {post.title}
                </h2>
                <p className="mt-2 text-base leading-relaxed" style={{ color: SOL.base00 }}>
                  {post.dek}
                </p>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium" style={{ color: SOL.yellow }}>
                  Read
                  <svg className="w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <BlogFooter />
    </main>
  );
}
