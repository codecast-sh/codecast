"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { ReactNode, AnchorHTMLAttributes } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { usePageMeta } from "../../pageMeta";
import { GUIDES, getGuide, guideHref, type Guide } from "./guides";
import { getGuideContent } from "./guideContent";

// Solarized light palette — matches the documentation page.
const SOL = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
};

function headingId(children: ReactNode): string {
  const text = Array.isArray(children) ? children.join("") : String(children ?? "");
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Internal /paths go through the router Link; external links open a new tab. */
function MdLink({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href?.startsWith("/")) {
    return (
      <Link href={href} className="underline underline-offset-2" style={{ color: SOL.blue }}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2" style={{ color: SOL.blue }}>
      {children}
    </a>
  );
}

const MD_COMPONENTS = {
  h2: ({ children }: { children?: ReactNode }) => (
    <h2
      id={headingId(children)}
      className="text-2xl font-bold font-mono mt-12 mb-4 pt-6"
      style={{ color: SOL.base03, borderTop: `1px solid ${SOL.base2}`, scrollMarginTop: "6rem" }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 id={headingId(children)} className="text-lg font-semibold font-mono mt-8 mb-3" style={{ color: SOL.base03 }}>
      {children}
    </h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="text-[15px] leading-7 mb-4" style={{ color: SOL.base00 }}>{children}</p>
  ),
  a: MdLink,
  strong: ({ children }: { children?: ReactNode }) => (
    <strong className="font-semibold" style={{ color: SOL.base02 }}>{children}</strong>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="list-disc pl-5 mb-4 space-y-1.5 text-[15px] leading-7" style={{ color: SOL.base00 }}>{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="list-decimal pl-5 mb-4 space-y-1.5 text-[15px] leading-7" style={{ color: SOL.base00 }}>{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li>{children}</li>,
  code: ({ className, children }: { className?: string; children?: ReactNode }) => {
    // Block code arrives wrapped in <pre>; inline code has no language class and
    // no newlines. Style inline here, let `pre` own the block chrome.
    const text = String(children ?? "");
    const isBlock = className?.includes("language-") || text.includes("\n");
    if (!isBlock) {
      return (
        <code className="px-1.5 py-0.5 rounded text-[13px] font-mono" style={{ backgroundColor: SOL.base2, color: SOL.base02 }}>
          {children}
        </code>
      );
    }
    return <code className="font-mono">{children}</code>;
  },
  pre: ({ children }: { children?: ReactNode }) => (
    <pre
      className="rounded-lg p-4 my-5 text-[13px] leading-relaxed overflow-x-auto font-mono"
      style={{ backgroundColor: SOL.base03, color: SOL.base1, border: `1px solid ${SOL.base02}` }}
    >
      {children}
    </pre>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="overflow-x-auto my-5">
      <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th
      className="text-left font-mono font-semibold px-3 py-2 text-[13px]"
      style={{ color: SOL.base03, borderBottom: `2px solid ${SOL.base2}` }}
    >
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="px-3 py-2 align-top text-[14px]" style={{ color: SOL.base00, borderBottom: `1px solid ${SOL.base2}` }}>
      {children}
    </td>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="rounded-lg p-4 my-4" style={{ backgroundColor: `${SOL.blue}10`, borderLeft: `3px solid ${SOL.blue}` }}>
      {children}
    </blockquote>
  ),
};

function GuideNav() {
  return (
    <nav
      className="backdrop-blur-sm sticky top-0 z-50"
      style={{ borderBottom: `1px solid ${SOL.base2}`, backgroundColor: "rgba(253,246,227,0.85)" }}
    >
      <div className="max-w-[90rem] mx-auto px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link href="/">
            <Logo size="md" className="[--logo-c:#444444] text-[#002b36]" />
          </Link>
          <div className="hidden md:flex items-center gap-1">
            <span style={{ color: SOL.base01 }}>/</span>
            <Link href="/documentation" className="font-mono text-sm font-medium" style={{ color: SOL.base00 }}>
              docs
            </Link>
            <span style={{ color: SOL.base01 }}>/</span>
            <span className="font-mono text-sm font-medium" style={{ color: SOL.base03 }}>guides</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/documentation" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: SOL.base00 }}>
            Docs
          </Link>
          <Link href="/changelog" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: SOL.base00 }}>
            Changelog
          </Link>
          <Link href="/blog" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: SOL.base00 }}>
            Blog
          </Link>
          <Link href="/signup">
            <Button className="font-medium text-white text-sm" style={{ backgroundColor: SOL.base03 }}>
              Get started
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}

function MoreGuides({ current }: { current: Guide }) {
  const others = GUIDES.filter((g) => g.slug !== current.slug);
  return (
    <div className="mt-16 pt-8" style={{ borderTop: `1px solid ${SOL.base2}` }}>
      <div className="text-[11px] font-mono uppercase tracking-wider mb-4" style={{ color: SOL.base01 }}>
        More guides
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {others.map((g) => (
          <Link
            key={g.slug}
            href={guideHref(g.slug)}
            className="rounded-lg p-4 transition-colors"
            style={{ backgroundColor: `${SOL.base2}55`, border: `1px solid ${SOL.base2}` }}
          >
            <div className="font-mono text-sm font-semibold mb-1" style={{ color: SOL.base03 }}>{g.title}</div>
            <div className="text-[13px] leading-relaxed" style={{ color: SOL.base00 }}>{g.dek}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function GuidePage() {
  const params = useParams<{ slug: string }>();
  const guide = getGuide(params.slug ?? "");

  usePageMeta(
    guide ? `${guide.title} — Codecast docs` : "Guide not found — Codecast docs",
    guide?.dek ?? "Deep technical guides to codecast's agent features.",
  );

  if (!guide) {
    return (
      <main className="min-h-screen w-full" style={{ backgroundColor: SOL.base3 }}>
        <GuideNav />
        <div className="max-w-2xl mx-auto px-6 py-24 text-center">
          <h1 className="text-2xl font-bold font-mono mb-3" style={{ color: SOL.base03 }}>No such guide</h1>
          <p className="mb-6" style={{ color: SOL.base00 }}>
            The guide you followed a link to does not exist (or moved).
          </p>
          <Link href="/documentation" className="underline" style={{ color: SOL.blue }}>
            Back to the documentation
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen w-full" style={{ backgroundColor: SOL.base3 }}>
      <GuideNav />
      <article className="max-w-3xl mx-auto px-6 pt-14 pb-24">
        <Link href="/documentation" className="inline-flex items-center gap-1 text-sm font-medium mb-8" style={{ color: SOL.yellow }}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Documentation
        </Link>

        <header className="mb-10">
          <div className="text-[11px] font-mono uppercase tracking-wider mb-3" style={{ color: SOL.base01 }}>
            {guide.category}
          </div>
          <h1 className="text-4xl font-bold leading-[1.15] tracking-tight font-mono" style={{ color: SOL.base03 }}>
            {guide.title}
          </h1>
          <p className="mt-4 text-lg leading-relaxed" style={{ color: SOL.base00 }}>{guide.dek}</p>
          {guide.installSlug && (
            <div
              className="mt-5 inline-flex items-center gap-2 rounded-lg px-3 py-2 font-mono text-[13px]"
              style={{ backgroundColor: SOL.base2, color: SOL.base02 }}
            >
              <span style={{ color: SOL.green }}>$</span>
              cast install {guide.installSlug}
            </div>
          )}
        </header>

        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
          {getGuideContent(guide.slug) ?? ""}
        </ReactMarkdown>

        <MoreGuides current={guide} />
      </article>
    </main>
  );
}
