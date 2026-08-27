import { useState } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Link, ArrowUpRight, ChevronsUpDown } from "lucide-react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { CONVEX_URL } from "../lib/localAuth";

const api = _api as any;

/** The raw serving origin — same frame source the decision queue uses. The
 *  artifact origin serves its own sandbox CSP, so the iframe is already
 *  isolated; no second sanitizer needed on our side. */
function pageFrameSrc(slug: string): string {
  return `${CONVEX_URL}/cli/a/${slug}`;
}

function pageShareUrl(slug: string): string {
  return `https://codecast.sh/a/${slug}`;
}

/** Viewer metadata for the header/caption. Enrichment only — the frame renders
 *  without it — so a failed query degrades the chrome, never the embed. */
function usePageMeta(slug: string) {
  const { data } = useQueryNoThrow(api.artifacts.getShared, { slug });
  return data as
    | { title: string; kind: string; gated: boolean; user: { name: string | null } | null }
    | null
    | undefined;
}

const EMBED_HEIGHT = 420;
const EMBED_HEIGHT_EXPANDED = "70vh";

/**
 * Block-level inline embed of a published page (`cast publish` output): a
 * titled card framing the live page, with an optional caption underneath —
 * the page equivalent of an image with a caption. Rendered for a publish URL
 * standing alone on its own line in message markdown, and for decision-queue
 * report attachments.
 *
 * All-span markup so it stays valid wherever markdown puts it (same contract
 * as DocEmbed).
 */
export function PublishedPageEmbed({ slug, caption }: { slug: string; caption?: string }) {
  const meta = usePageMeta(slug);
  const [expanded, setExpanded] = useState(false);

  // Deleted or never existed: a full-height frame of a 404 reads as breakage.
  // Degrade to a compact note carrying the link.
  if (meta === null) {
    return (
      <span className="not-prose my-3 flex max-w-md flex-col gap-1 rounded-md border border-dashed border-sol-border bg-sol-bg-alt px-3 py-2 text-xs">
        <span className="text-sol-text-dim">Published page unavailable</span>
        <a
          href={pageShareUrl(slug)}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-sol-text-dim hover:text-sol-blue"
        >
          {pageShareUrl(slug)}
        </a>
      </span>
    );
  }

  const title = meta?.title || "Published page";
  return (
    <span className="not-prose my-3 block">
      <span className="block overflow-hidden rounded-md border border-sol-border">
        <span className="flex items-center gap-2 border-b border-sol-border bg-sol-bg-alt px-3 py-1.5">
          <PageFavicon className="h-4 w-4" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-sol-text">{title}</span>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-blue transition-colors"
            title={expanded ? "Collapse" : "Expand"}
          >
            <ChevronsUpDown className="h-3 w-3" />
          </button>
          <a
            href={pageShareUrl(slug)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-[11px] text-sol-text-dim hover:text-sol-blue transition-colors"
          >
            open
            <ArrowUpRight className="h-3 w-3" />
          </a>
        </span>
        <iframe
          src={pageFrameSrc(slug)}
          className="w-full bg-sol-card"
          style={{ height: expanded ? EMBED_HEIGHT_EXPANDED : EMBED_HEIGHT }}
          sandbox="allow-scripts allow-popups"
          title={title}
        />
      </span>
      {caption && (
        <span className="block mt-1 text-[11px] leading-snug text-sol-text-muted">{caption}</span>
      )}
    </span>
  );
}

/** Tiny "favicon" disc: the published page's identity mark. Every flat accent
 *  pill already names an internal object (blue session, cyan plan, green doc,
 *  violet project…), so a page — a link OUT to the web — gets a duotone disc
 *  no entity owns instead of another accent from the same family. */
function PageFavicon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sol-cyan/35 to-sol-violet/35 ${className}`}
    >
      <Link className="h-[62%] w-[62%] text-sol-text" />
    </span>
  );
}

/**
 * Inline reference to a published page: a small titled pill, for a publish URL
 * that sits inside a sentence rather than on its own line. Opens the page in a
 * new tab; the label is the live page title (or the author's link text when
 * they wrote one).
 *
 * Styled as a miniature browser chip — rounded-full on neutral chrome with a
 * favicon disc and an external-link arrow — deliberately NOT the rectangular
 * accent-tinted shape of entity pills: those mean "internal object", this
 * means "web page".
 */
export function PublishedPagePill({
  slug,
  href,
  label,
}: {
  slug: string;
  href: string;
  label?: string;
}) {
  const meta = usePageMeta(slug);
  const text = label || meta?.title || "published page";
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex max-w-xs items-center gap-1.5 rounded-full border border-sol-border bg-sol-bg-alt py-px pl-1 pr-2 align-baseline text-[11px] font-medium leading-[1.4] text-sol-text-secondary no-underline transition-colors hover:border-sol-violet/50 hover:text-sol-text"
      title={meta?.title || href}
    >
      <PageFavicon />
      <span className="truncate">{text}</span>
      <ArrowUpRight className="h-2.5 w-2.5 flex-shrink-0 text-sol-text-dim transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-sol-violet" />
    </a>
  );
}
