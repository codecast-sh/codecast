"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, type ReactNode, type AnchorHTMLAttributes } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { usePageMeta } from "../../pageMeta";
import { SOL, Figure, Screenshot } from "../../blog/blogChrome";
import { FigureStyles } from "../../blog/figureKit";
import { GUIDES, formatGuideDate, getGuide, type Guide } from "./guides";
import { getGuideContent } from "./guideContent";
import { GuideCard } from "./GuideCard";
import { guideFigure } from "./figures";

/** Words a reader gets through in a minute of technical prose. */
const WORDS_PER_MINUTE = 220;

function readingMinutes(markdown: string): number {
  return Math.max(1, Math.round(markdown.split(/\s+/).filter(Boolean).length / WORDS_PER_MINUTE));
}

type MdNode = ExtraProps["node"];

/** The text of a fenced block's language and body, when `node` is one. */
function fenceOf(node: MdNode): { lang: string; body: string } | null {
  const code = node?.children[0];
  if (!code || code.type !== "element" || code.tagName !== "code") return null;
  const cls = code.properties?.className;
  const lang = (Array.isArray(cls) ? cls : []).map(String).find((c) => c.startsWith("language-"))?.slice(9) ?? "";
  const text = code.children[0];
  return { lang, body: text?.type === "text" ? text.value : "" };
}

/**
 * A ```figure fence: the first line names a figure exported from
 * figures/<slug>.tsx, the rest is its caption.
 */
function GuideFigure({ slug, body }: { slug: string; body: string }) {
  const [name, ...rest] = body.trim().split("\n");
  const Comp = guideFigure(slug, name.trim());
  if (!Comp) return null;
  return (
    <Figure wide caption={rest.join(" ").trim()}>
      <Suspense fallback={<div className="h-64" />}>
        <Comp />
      </Suspense>
    </Figure>
  );
}

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

/** True when a paragraph holds only images (markdown wraps a lone image in <p>). */
function onlyImages(node: MdNode): boolean {
  const kids = node?.children ?? [];
  return kids.some((k) => k.type === "element" && k.tagName === "img")
    && kids.every((k) => (k.type === "element" && k.tagName === "img") || (k.type === "text" && !k.value.trim()));
}

const mdComponents = (slug: string) => ({
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
  p: ({ node, children }: { children?: ReactNode } & ExtraProps) =>
    onlyImages(node) ? <>{children}</> : (
      <p className="text-[15px] leading-7 mb-4" style={{ color: SOL.base00 }}>{children}</p>
    ),
  // ![alt](/documentation/<slug>/shot.webp "caption") renders as a framed screenshot.
  img: ({ src, alt, title }: { src?: string | Blob; alt?: string; title?: string }) => (
    <Screenshot wide src={typeof src === "string" ? src : ""} alt={alt ?? ""} caption={title ?? alt ?? ""} />
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
  pre: ({ node, children }: { children?: ReactNode } & ExtraProps) => {
    const fence = fenceOf(node);
    if (fence?.lang === "figure") return <GuideFigure slug={slug} body={fence.body} />;
    return (
    <pre
      className="rounded-lg p-4 my-5 text-[13px] leading-relaxed overflow-x-auto font-mono"
      style={{ backgroundColor: SOL.base03, color: SOL.base1, border: `1px solid ${SOL.base02}` }}
    >
      {children}
    </pre>
    );
  },
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
});

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
        {others.map((g) => <GuideCard key={g.slug} guide={g} />)}
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

  const content = getGuideContent(guide.slug) ?? "";

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <FigureStyles />
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
          <div className="mt-5 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <time dateTime={guide.published}>{formatGuideDate(guide.published)}</time>
            <span aria-hidden>&middot;</span>
            <span>{readingMinutes(content)} min read</span>
          </div>
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

        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents(guide.slug)}>
          {content}
        </ReactMarkdown>

        <MoreGuides current={guide} />
      </article>
    </main>
  );
}
