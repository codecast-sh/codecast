"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { BlogNav, SOL } from "./blogChrome";
import { useRouteMeta } from "../pageMeta";
import { POSTS, type BlogPost } from "./posts";

// Cards rise in one staggered wave on load; reduced motion shows them at rest.
const CSS = `
.bi-rise{opacity:0;transform:translateY(14px);animation:bi-rise .7s cubic-bezier(.2,.7,.2,1) var(--at,0s) forwards}
@keyframes bi-rise{to{opacity:1;transform:none}}
.bi-card:hover .bi-img{transform:scale(1.035)}
.bi-card:hover .bi-title{color:${SOL.orange}}
@media (prefers-reduced-motion:reduce){.bi-rise{opacity:1;transform:none;animation:none}.bi-img{transition:none!important}}
`;

const rise = (i: number) => ({ "--at": `${0.08 + i * 0.07}s` }) as CSSProperties;

function Cover({ post, className }: { post: BlogPost; className: string }) {
  return (
    <div className={`rounded-xl border overflow-hidden shadow-lg ${className}`} style={{ borderColor: SOL.base2, backgroundColor: SOL.base2 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={post.cover.src} alt={post.cover.alt} loading="lazy" className="bi-img w-full h-full object-cover object-left-top transition-transform duration-500 ease-out" />
    </div>
  );
}

function Meta({ post }: { post: BlogPost }) {
  return (
    <div className="flex items-center gap-3 font-mono text-xs" style={{ color: SOL.base1 }}>
      <time dateTime={post.date}>{post.dateLabel}</time>
      <span aria-hidden>&middot;</span>
      <span>{post.readingMinutes} min read</span>
    </div>
  );
}

export default function BlogIndexPage() {
  useRouteMeta("/blog");
  const [latest, ...rest] = POSTS;

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <style>{CSS}</style>
      <BlogNav />

      <section className="max-w-5xl mx-auto px-6 pt-16 md:pt-20 pb-10">
        <h1 className="bi-rise text-4xl md:text-5xl font-bold tracking-tight font-mono" style={{ color: SOL.base03, ...rise(0) }}>
          Blog
        </h1>
        <p className="bi-rise mt-4 text-lg leading-relaxed max-w-2xl" style={{ color: SOL.base00, ...rise(1) }}>
          How we run a fleet of coding agents, what we built to steer them, and what we learned along the way.
        </p>
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-14">
        <Link href={`/blog/${latest.slug}`} className="bi-card bi-rise group grid md:grid-cols-[1fr_1.15fr] gap-8 md:gap-10 items-center" style={rise(2)}>
          <div className="order-2 md:order-1">
            <div className="font-mono text-xs font-bold mb-3" style={{ color: SOL.orange }}>Latest</div>
            <h2 className="bi-title text-3xl md:text-4xl font-bold font-mono tracking-tight leading-[1.15] transition-colors" style={{ color: SOL.base03 }}>
              {latest.title}
            </h2>
            <p className="mt-4 text-[17px] leading-relaxed" style={{ color: SOL.base00 }}>{latest.dek}</p>
            <div className="mt-5"><Meta post={latest} /></div>
          </div>
          <Cover post={latest} className="order-1 md:order-2" />
        </Link>
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-24 border-t pt-14" style={{ borderColor: SOL.base2 }}>
        <ul className="grid sm:grid-cols-2 gap-x-10 gap-y-14">
          {rest.map((post, i) => (
            <li key={post.slug} className="bi-rise" style={rise(3 + i)}>
              <Link href={`/blog/${post.slug}`} className="bi-card group block">
                <Cover post={post} className="aspect-[16/10]" />
                <div className="mt-5"><Meta post={post} /></div>
                <h2 className="bi-title mt-2 text-xl font-bold font-mono tracking-tight leading-snug transition-colors" style={{ color: SOL.base03 }}>
                  {post.title}
                </h2>
                <p className="mt-2 text-[15px] leading-relaxed line-clamp-3" style={{ color: SOL.base00 }}>{post.dek}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
