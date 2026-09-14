"use client";

import Link from "next/link";
import { SITE_LINKS } from "@/lib/siteLinks";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { MarketingNav } from "@/components/marketing/MarketingNav";

/**
 * Shared chrome for the /blog surface — kept inside the blog route folder so the
 * blog owns its own layout without touching any other marketing page. Colors are
 * the Solarized-light palette used verbatim across the rest of the marketing site
 * (see (marketing)/page.tsx, /about, /changelog); headings are mono, same as the
 * landing page.
 */

export const SOL = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
} as const;

/**
 * Nav for the blog and support surfaces: the shared marketing bar at the
 * blog's narrower width. `active` is the path of the page rendering it.
 */
export function BlogNav({ active = "/blog" }: { active?: string }) {
  return <MarketingNav active={active} containerClassName="max-w-5xl" />;
}

export function BlogFooter() {
  return (
    <footer style={{ borderTop: `1px solid ${SOL.base2}`, backgroundColor: SOL.base3 }}>
      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="grid md:grid-cols-4 gap-8">
          <div>
            <Logo size="md" className="[--logo-c:#444444] text-[#002b36] mb-4" />
            <p className="text-sm text-[#657b83]">
              See, steer, and remember every coding agent session — any agent, any machine.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Product</h4>
            <ul className="space-y-2 text-sm text-[#657b83]">
              <li><Link href="/documentation" className="hover:text-[#073642]">Documentation</Link></li>
              <li><Link href="/features" className="hover:text-[#073642]">CLI</Link></li>
              <li><Link href="/changelog" className="hover:text-[#073642]">Changelog</Link></li>
              <li><Link href="/pricing" className="hover:text-[#073642]">Pricing</Link></li>
              <li><Link href="/compare" className="hover:text-[#073642]">Compare</Link></li>
              <li><Link href="/security" className="hover:text-[#073642]">Security</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Company</h4>
            <ul className="space-y-2 text-sm text-[#657b83]">
              <li><Link href="/blog" className="hover:text-[#073642]">Blog</Link></li>
              <li><Link href="/about" className="hover:text-[#073642]">About</Link></li>
              <li><Link href="/privacy" className="hover:text-[#073642]">Privacy</Link></li>
              <li><Link href="/support" className="hover:text-[#073642]">Support</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Connect</h4>
            <ul className="space-y-2 text-sm text-[#657b83]">
              <li><a href="https://github.com/codecast-sh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">GitHub</a></li>
              <li><a href="https://x.com/codecastsh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Twitter</a></li>
              <li><a href={SITE_LINKS.discord} className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Discord</a></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-[#eee8d5] mt-8 pt-8 text-center text-sm text-[#839496]">
          &copy; 2026 Codecast
        </div>
      </div>
    </footer>
  );
}

/**
 * Terminal card matching the landing page's terminal styling (traffic-light dots,
 * dark Solarized body). `children` is rendered inside a horizontally scrollable
 * <pre> so captured CLI output never forces the page to scroll sideways on mobile.
 * Pass `wrap` for prose-heavy captures (transcript excerpts) whose long lines
 * should flow rather than scroll; leave it off for column-aligned output.
 */
export function Terminal({ label, wrap = false, children }: { label: string; wrap?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-xl border shadow-xl overflow-hidden my-6" style={{ backgroundColor: SOL.base03, borderColor: "#094959" }}>
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #094959" }}>
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: SOL.red }} />
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: SOL.yellow }} />
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: SOL.green }} />
        </div>
        <span className="text-xs font-mono ml-2" style={{ color: SOL.base01 }}>{label}</span>
      </div>
      <div className="overflow-x-auto">
        <pre className={`p-4 font-mono text-[12px] leading-relaxed${wrap ? " whitespace-pre-wrap break-words" : ""}`} style={{ color: SOL.base0 }}>{children}</pre>
      </div>
    </div>
  );
}

/** A shell prompt line: green `$` then the muted command text. */
export function Cmd({ children }: { children: ReactNode }) {
  return (
    <span>
      <span style={{ color: SOL.green }}>$</span>
      <span style={{ color: SOL.base1 }}> {children}</span>
      {"\n"}
    </span>
  );
}

/** Section heading inside a post body. */
export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-2xl font-bold font-mono tracking-tight mt-12 mb-4" style={{ color: SOL.base03 }}>
      {children}
    </h2>
  );
}

/** Body paragraph inside a post. */
export function P({ children }: { children: ReactNode }) {
  return <p className="text-[17px] leading-8 mb-5" style={{ color: SOL.base01 }}>{children}</p>;
}

/** Inline code inside post prose. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[14px] px-1.5 py-0.5 rounded" style={{ backgroundColor: SOL.base2, color: SOL.base02 }}>
      {children}
    </code>
  );
}

/** A framed screenshot with a mono caption; images live under public/blog/<slug>/. */
export function Screenshot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="my-8">
      <div className="rounded-xl border shadow-xl overflow-hidden" style={{ borderColor: SOL.base2, backgroundColor: SOL.base3 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="w-full block" loading="lazy" />
      </div>
      <figcaption className="mt-3 text-sm font-mono text-center" style={{ color: SOL.base1 }}>
        {caption}
      </figcaption>
    </figure>
  );
}
