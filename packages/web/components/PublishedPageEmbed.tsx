import { useRef, useState } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Link, Link2, ArrowUpRight, ChevronsUpDown, Columns2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useFrameTheme } from "../hooks/useFrameTheme";
import { CONVEX_URL } from "../lib/localAuth";
import { copyToClipboard } from "../lib/utils";
import { openBrowserPane } from "../lib/stage";

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

/**
 * Open the page as a stage pane. The pane frames the SERVING origin, not the
 * codecast share page: the same source the embed above already uses, so the
 * page arrives under its own sandbox CSP and the share page's chrome does not
 * wrap it a second time.
 */
function openPageInPane(slug: string) {
  openBrowserPane({ kind: "url", url: pageFrameSrc(slug) });
}

const HEADER_ACTION =
  "flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-blue transition-colors";

/** Copy the public share URL (`codecast.sh/a/<slug>`), not the serving origin
 *  the iframe uses. Same URL "open" already points at. */
function CopyPageLinkButton({ slug, className }: { slug: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copyToClipboard(pageShareUrl(slug)).then(
          () => toast.success("Link copied"),
          () => toast.error("Couldn't copy link"),
        );
      }}
      className={className}
      title="Copy link to published page"
      aria-label="Copy link to published page"
    >
      <Link2 className="h-3 w-3" />
    </button>
  );
}

/** "Open in a pane", in the two sizes this file needs: a strip button in the
 *  embed header, and a quiet sibling glyph on the inline pill. */
function OpenInPaneButton({ slug, className }: { slug: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openPageInPane(slug);
      }}
      className={className}
      title="Open beside your work, as a pane"
      aria-label="Open in a pane"
    >
      <Columns2 className="h-3 w-3" />
    </button>
  );
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
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { theme, onLoad } = useFrameTheme(frameRef);
  // The theme at mount rides the address so the first paint already matches;
  // later changes arrive as messages, because a new src would reload the page.
  const [mountTheme] = useState(theme);
  const src = `${pageFrameSrc(slug)}?theme=${mountTheme}`;

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
          <CopyPageLinkButton slug={slug} className={HEADER_ACTION} />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={HEADER_ACTION}
            title={expanded ? "Collapse" : "Expand"}
          >
            <ChevronsUpDown className="h-3 w-3" />
          </button>
          <OpenInPaneButton slug={slug} className={HEADER_ACTION} />
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
          ref={frameRef}
          src={src}
          onLoad={onLoad}
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
    <span className="group/page inline-flex max-w-xs items-center align-baseline">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="group inline-flex min-w-0 items-center gap-1.5 rounded-full border border-sol-border bg-sol-bg-alt py-px pl-1 pr-2 align-baseline text-[11px] font-medium leading-[1.4] text-sol-text-secondary no-underline transition-colors hover:border-sol-violet/50 hover:text-sol-text"
        title={meta?.title || href}
      >
        <PageFavicon />
        <span className="truncate">{text}</span>
        <ArrowUpRight className="h-2.5 w-2.5 flex-shrink-0 text-sol-text-dim transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-sol-violet" />
      </a>
      {/* A second verb on an inline pill would crowd the sentence it sits in,
          so it waits for the pointer (and for a keyboard, for focus). */}
      <OpenInPaneButton
        slug={slug}
        className="ml-0.5 flex-shrink-0 rounded p-0.5 text-sol-text-dim opacity-0 transition-opacity hover:text-sol-violet focus-visible:opacity-100 group-hover/page:opacity-100"
      />
    </span>
  );
}
