"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";

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

export function BlogNav() {
  return (
    <nav
      className="backdrop-blur-sm sticky top-0 z-50"
      style={{ borderBottom: `1px solid ${SOL.base2}`, backgroundColor: "rgba(253,246,227,0.8)" }}
    >
      <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <Link href="/">
          <Logo size="md" className="[--logo-c:#444444] text-[#002b36]" />
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href="/documentation"
            className="hidden sm:block font-medium text-sm px-3 py-1.5 text-[#657b83] hover:text-[#002b36] transition-colors"
          >
            Docs
          </Link>
          <Link
            href="/features"
            className="hidden sm:block font-medium text-sm px-3 py-1.5 text-[#657b83] hover:text-[#002b36] transition-colors"
          >
            CLI
          </Link>
          <Link
            href="/blog"
            className="hidden sm:block font-medium text-sm px-3 py-1.5 text-[#002b36] transition-colors"
          >
            Blog
          </Link>
          <Link
            href="/changelog"
            className="hidden sm:block font-medium text-sm px-3 py-1.5 text-[#657b83] hover:text-[#002b36] transition-colors"
          >
            Changelog
          </Link>
          <Link
            href="/pricing"
            className="hidden sm:block font-medium text-sm px-3 py-1.5 text-[#657b83] hover:text-[#002b36] transition-colors"
          >
            Pricing
          </Link>
          <a
            href="https://github.com/codecast-sh"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center px-2 py-1.5 text-[#657b83] hover:text-[#002b36] transition-colors"
            aria-label="GitHub"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
          </a>
          <Link href="/login">
            <Button variant="ghost" className="font-medium text-[#657b83] hover:text-[#002b36] hover:bg-[#eee8d5]">
              Sign in
            </Button>
          </Link>
          <Link href="/signup">
            <Button className="font-medium text-white" style={{ backgroundColor: SOL.base03 }}>
              Get started
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
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
              <li><Link href="/security" className="hover:text-[#073642]">Security</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Company</h4>
            <ul className="space-y-2 text-sm text-[#657b83]">
              <li><Link href="/blog" className="hover:text-[#073642]">Blog</Link></li>
              <li><Link href="/about" className="hover:text-[#073642]">About</Link></li>
              <li><Link href="/privacy" className="hover:text-[#073642]">Privacy</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-[#002b36] mb-3 text-sm">Connect</h4>
            <ul className="space-y-2 text-sm text-[#657b83]">
              <li><a href="https://github.com/codecast-sh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">GitHub</a></li>
              <li><a href="https://x.com/codecastsh" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Twitter</a></li>
              <li><a href="https://discord.gg/S7V5Wnfq" className="hover:text-[#073642]" target="_blank" rel="noopener noreferrer">Discord</a></li>
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
 */
export function Terminal({ label, children }: { label: string; children: ReactNode }) {
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
        <pre className="p-4 font-mono text-[12px] leading-relaxed" style={{ color: SOL.base0 }}>{children}</pre>
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
