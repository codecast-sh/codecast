import { useRef, useState, type ReactNode } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Link, Link2, ArrowUpRight, ChevronsUpDown, Columns2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useFrameTheme } from "../hooks/useFrameTheme";
import { useNativeBrowserPane } from "../hooks/useNativeBrowserPane";
import { copyToClipboard } from "../lib/utils";
import { isDesktop } from "../lib/desktop";
import { openBrowserPane } from "../lib/stage";
import { pageFrameSrc, pageShareUrl } from "../lib/publishedPageUrls";
import { claudeArtifactUrl } from "../lib/entityLinks";
import { ClaudeIcon } from "./BrandIcons";

const api = _api as any;

// ---------------------------------------------------------------------------
// The chrome every "web page" reference wears
//
// Two shapes, shared by every kind of page prose can name: a block card when
// the link stands alone on its line (header strip with the page's verbs, a
// body, an optional caption underneath — the page equivalent of an image with
// a caption), and a small titled pill when the link sits inside a sentence.
// The pill is a miniature browser chip — rounded-full on neutral chrome with a
// favicon disc and an external-link arrow — deliberately NOT the rectangular
// accent-tinted shape of entity pills: those mean "internal object", this
// means "web page".
//
// All-span markup so it stays valid wherever markdown puts it (same contract
// as DocEmbed).
// ---------------------------------------------------------------------------

const HEADER_ACTION =
  "flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-blue transition-colors";

/** Copy a page's share URL. */
function CopyLinkButton({ url, title, className }: { url: string; title: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copyToClipboard(url).then(
          () => toast.success("Link copied"),
          () => toast.error("Couldn't copy link"),
        );
      }}
      className={className}
      title={title}
      aria-label={title}
    >
      <Link2 className="h-3 w-3" />
    </button>
  );
}

/** "Open in a pane", in the two sizes this file needs: a strip button in the
 *  card header, and a quiet sibling glyph on the inline pill. `native` asks
 *  for the desktop's native view: the pane for a site that refuses to be
 *  framed. */
function OpenInPaneButton({ url, native, className }: { url: string; native?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openBrowserPane({ kind: "url", url }, native ? { native: true } : undefined);
      }}
      className={className}
      title="Open beside your work, as a pane"
      aria-label="Open in a pane"
    >
      <Columns2 className="h-3 w-3" />
    </button>
  );
}

/** The block card: header strip (icon, title, verbs, "open"), a body, and the
 *  caption the author wrote under it. */
function PageCard({ icon, title, href, actions, caption, children }: {
  icon: ReactNode;
  title: string;
  href: string;
  actions?: ReactNode;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <span className="not-prose my-3 block">
      <span className="block overflow-hidden rounded-md border border-sol-border">
        <span className="flex items-center gap-2 border-b border-sol-border bg-sol-bg-alt px-3 py-1.5">
          {icon}
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-sol-text">{title}</span>
          {actions}
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-0.5 text-[11px] text-sol-text-dim hover:text-sol-blue transition-colors"
          >
            open
            <ArrowUpRight className="h-3 w-3" />
          </a>
        </span>
        {children}
      </span>
      {caption && (
        <span className="block mt-1 text-[11px] leading-snug text-sol-text-muted">{caption}</span>
      )}
    </span>
  );
}

/** The inline pill. Opens the page in a new tab; `pane` adds the quiet
 *  "open in a pane" glyph that waits for the pointer (and for a keyboard, for
 *  focus) — a second verb always visible would crowd the sentence it sits in. */
function PagePill({ icon, text, title, href, hoverClass, pane }: {
  icon: ReactNode;
  text: string;
  title: string;
  href: string;
  hoverClass: string;
  pane?: { url: string; native?: boolean };
}) {
  return (
    <span className="group/page inline-flex max-w-xs items-center align-baseline">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`group inline-flex min-w-0 items-center gap-1.5 rounded-full border border-sol-border bg-sol-bg-alt py-px pl-1 pr-2 align-baseline text-[11px] font-medium leading-[1.4] text-sol-text-secondary no-underline transition-colors hover:text-sol-text ${hoverClass}`}
        title={title}
      >
        {icon}
        <span className="truncate">{text}</span>
        <ArrowUpRight className="h-2.5 w-2.5 flex-shrink-0 text-sol-text-dim transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-sol-violet" />
      </a>
      {pane && (
        <OpenInPaneButton
          url={pane.url}
          native={pane.native}
          className="ml-0.5 flex-shrink-0 rounded p-0.5 text-sol-text-dim opacity-0 transition-opacity hover:text-sol-violet focus-visible:opacity-100 group-hover/page:opacity-100"
        />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Published codecast pages (`cast publish` output)
// ---------------------------------------------------------------------------

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
 * Block-level inline embed of a published page: a titled card framing the
 * live page. Rendered for a publish URL standing alone on its own line in
 * message markdown, and for decision-queue report attachments.
 */
export function PublishedPageEmbed({ slug, caption, height }: {
  slug: string;
  caption?: string;
  /** A shorter frame where the page is a slice of something else (a decision
   *  card in a list), not the page's own surface. Its own expander still
   *  opens it to full height. */
  height?: number;
}) {
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
    <PageCard
      icon={<PageFavicon className="h-4 w-4" />}
      title={title}
      href={pageShareUrl(slug)}
      caption={caption}
      actions={
        <>
          {/* Copy the public share URL, not the serving origin the iframe uses. */}
          <CopyLinkButton url={pageShareUrl(slug)} title="Copy link to published page" className={HEADER_ACTION} />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className={HEADER_ACTION}
            title={expanded ? "Collapse" : "Expand"}
          >
            <ChevronsUpDown className="h-3 w-3" />
          </button>
          {/* The pane frames the SERVING origin, the same source the iframe
              uses, so the page arrives under its own sandbox CSP and the share
              page's chrome does not wrap it a second time. */}
          <OpenInPaneButton url={pageFrameSrc(slug)} className={HEADER_ACTION} />
        </>
      }
    >
      <iframe
        ref={frameRef}
        src={src}
        onLoad={onLoad}
        className="w-full bg-sol-card"
        style={{ height: expanded ? EMBED_HEIGHT_EXPANDED : (height ?? EMBED_HEIGHT) }}
        sandbox="allow-scripts allow-popups"
        title={title}
      />
    </PageCard>
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
 * Inline reference to a published page, for a publish URL inside a sentence.
 * The label is the live page title (or the author's link text when they
 * wrote one).
 */
export function PublishedPagePill({ slug, href, label }: { slug: string; href: string; label?: string }) {
  const meta = usePageMeta(slug);
  return (
    <PagePill
      icon={<PageFavicon />}
      text={label || meta?.title || "published page"}
      title={meta?.title || href}
      href={href}
      hoverClass="hover:border-sol-violet/50"
      pane={{ url: pageFrameSrc(slug) }}
    />
  );
}

// ---------------------------------------------------------------------------
// Claude artifacts (claude.ai/public/artifacts/<id>)
//
// The same two shapes as a published page, with one forced difference:
// claude.ai answers every artifact page with `frame-ancestors 'self'`, so no
// other site can frame it — an iframe here would paint a blank refusal, and
// nothing on the client can tell that refusal from a page that loaded
// (browser/backends/FrameBackend). The card body is therefore a tile that
// opens the artifact, and "open in a pane" appears only where the desktop's
// native view can show a site that refuses to be framed.
// ---------------------------------------------------------------------------

const CLAUDE_TITLE = "Claude artifact";

/** The artifact's identity mark: Claude's own glyph on a warm disc, so a
 *  reader tells it from a codecast page at a glance. */
function ClaudeFavicon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center justify-center rounded-full bg-sol-orange/20 text-sol-orange ${className}`}
    >
      <ClaudeIcon className="h-[58%] w-[58%]" />
    </span>
  );
}

/** True where a pane can show claude.ai at all: the desktop's native view. */
function useCanPaneClaude(): boolean {
  const nativeReady = useNativeBrowserPane();
  return isDesktop() && nativeReady;
}

/** Block-level card for a Claude artifact URL standing alone on its line.
 *  claude.ai publishes no per-artifact title (its page metadata is the same
 *  for every artifact), so the author's caption IS the title when they wrote
 *  one, rather than a line repeated under a generic header. */
export function ClaudeArtifactEmbed({ id, caption }: { id: string; caption?: string }) {
  const url = claudeArtifactUrl(id);
  const canPane = useCanPaneClaude();
  return (
    <PageCard
      icon={<ClaudeFavicon className="h-4 w-4" />}
      title={caption || CLAUDE_TITLE}
      href={url}
      actions={
        <>
          <CopyLinkButton url={url} title="Copy link to Claude artifact" className={HEADER_ACTION} />
          {canPane && <OpenInPaneButton url={url} native className={HEADER_ACTION} />}
        </>
      }
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-3 bg-sol-card px-3 py-3 no-underline transition-colors hover:bg-sol-bg-alt"
        title={url}
      >
        <ClaudeFavicon className="h-9 w-9" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-sol-text">Open on claude.ai</span>
          <span className="text-[11px] leading-snug text-sol-text-dim">
            claude.ai does not let other sites frame an artifact, so it opens in its own tab.
          </span>
          <span className="truncate font-mono text-[10px] text-sol-text-dim">claude.ai/public/artifacts/{id}</span>
        </span>
        <ArrowUpRight className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-sol-text-dim transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-sol-orange" />
      </a>
    </PageCard>
  );
}

/** Inline pill for a Claude artifact URL inside a sentence. */
export function ClaudeArtifactPill({ id, href, label }: { id: string; href: string; label?: string }) {
  const url = claudeArtifactUrl(id);
  const canPane = useCanPaneClaude();
  return (
    <PagePill
      icon={<ClaudeFavicon />}
      text={label || CLAUDE_TITLE}
      title={href}
      href={href}
      hoverClass="hover:border-sol-orange/50"
      pane={canPane ? { url, native: true } : undefined}
    />
  );
}
