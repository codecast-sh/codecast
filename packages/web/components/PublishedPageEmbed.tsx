import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Link as LinkIcon, Link2, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { linkPreviewStale } from "@codecast/convex/convex/lib/linkPreviewMeta";
import { PAGE_HEIGHT_MESSAGE } from "../../shared/render/pageTheme";
import { useFrameTheme } from "../hooks/useFrameTheme";
import { usePageNotes } from "../hooks/usePageNotes";
import { usePageAgent, type PageAgent } from "../hooks/usePageAgent";
import { PAGE_AGENT_LABELS } from "@codecast/shared/contracts";
import { useNativeBrowserPane } from "../hooks/useNativeBrowserPane";
import { copyToClipboard } from "../lib/utils";
import { isDesktop } from "../lib/desktop";
import { openBrowserPane } from "../lib/stage";
import { pageFrameSrc, pageShareUrl } from "../lib/publishedPageUrls";
import { claudeArtifactUrl } from "../lib/entityLinks";
import { FeatureUpsell } from "./agentFeatures/FeatureUpsell";
import { ClaudeIcon } from "./BrandIcons";
import { HeightGrip, savedGripHeight } from "./HeightGrip";
import { KeyCap } from "./KeyCap";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { useWatchEffect } from "../hooks/useWatchEffect";

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
export function PageCard({ icon, title, href, actions, caption, children }: {
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
    | { title: string; kind: string; version: number; gated: boolean; user: { name: string | null } | null }
    | null
    | undefined;
}

/** The page's agent, as a quiet chip: a dot and a word, the dot breathing
 *  while the agent is on the page. The same chip the page's own bar shows. */
function PageAgentStatus({ agent }: { agent: PageAgent }) {
  const tone =
    agent.chip === "needs_input" ? "text-sol-yellow" :
    agent.chip === "updating" ? "text-sol-red" :
    agent.chip === "working" ? "text-sol-blue" : "text-sol-text-dim";
  const busy = agent.chip === "working" || agent.chip === "updating";
  return (
    <span
      className={`page-embed__agent inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap px-1.5 font-mono text-[10.5px] ${tone}`}
      role="status"
      title={agent.chip === "updating"
        ? "A comment was sent to the session that made this page; it reloads here when a new version lands."
        : "The session that made this page."}
    >
      <span className={`h-1.5 w-1.5 rounded-full bg-current ${busy ? "page-embed__agent-dot--busy" : "opacity-70"}`} aria-hidden />
      {PAGE_AGENT_LABELS[agent.chip]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The frameless shell
//
// A page an agent made is part of its reply, so it sits straight on the
// thread: no border, no header strip, no bar inside it. Its edge shows only
// as a soft shadow that lifts a little while the pointer is over it, and its
// verbs float in as one glass toolbar in the top corner (held up on a touch
// screen, where there is no hover). Pinning notes keeps the toolbar up and
// rings the page yellow, so the mode is never invisible. The toolbar can fold the
// page down to its title row. The bottom edge is a resize grip that appears
// with the toolbar; a double click on it hands the height back to the page.
// ---------------------------------------------------------------------------

const TOOL =
  "page-embed__tool relative inline-flex h-[26px] min-w-[26px] items-center justify-center gap-1 rounded-full px-1.5 " +
  "text-sol-text-muted transition-colors hover:bg-sol-bg-highlight hover:text-sol-text focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-sol-blue/60";

/** One toolbar verb with its tooltip. */
function Tool({ label, onClick, pressed, className = "", children }: {
  label: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick();
          }}
          aria-pressed={pressed}
          aria-label={typeof label === "string" ? label : undefined}
          className={`${TOOL} ${className}`}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8} className="flex items-center gap-1.5 border border-sol-border/60 bg-sol-bg-alt px-2 py-1 text-[11px] text-sol-text shadow-md">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** A page's verbs: comment on it (where the viewer can reply in this thread),
 *  copy its share link, expand it, open it beside your work, open it in a tab. */
export function PublishedPageActions({ slug, expanded, onToggleExpand, notes }: {
  slug: string;
  expanded: boolean;
  /** Absent when the page already fits: there is nothing to expand. */
  onToggleExpand?: () => void;
  notes?: ReturnType<typeof usePageNotes>;
}) {
  const [copied, setCopied] = useState(false);
  useWatchEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <>
      {notes && (
        <Tool
          label={notes.pinMode ? <>Stop pinning <KeyCap size="xs">Esc</KeyCap></> : "Pin a note, or select text on the page"}
          onClick={() => notes.setPinMode(!notes.pinMode)}
          pressed={notes.pinMode}
          className={notes.pinMode ? "!bg-sol-yellow/20 !text-sol-yellow" : ""}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {notes.count > 0 && <span className="font-mono text-[11px] tabular-nums text-sol-yellow">{notes.count}</span>}
        </Tool>
      )}
      {/* The public share URL, not the serving origin the frame uses. */}
      <Tool
        label={copied ? "Copied" : "Copy link"}
        onClick={() => void copyToClipboard(pageShareUrl(slug)).then(() => setCopied(true), () => toast.error("Couldn't copy link"))}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-sol-green" /> : <Link2 className="h-3.5 w-3.5" />}
      </Tool>
      {onToggleExpand && (
        <Tool label={expanded ? "Shrink" : "Expand"} onClick={onToggleExpand} pressed={expanded}>
          {expanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
        </Tool>
      )}
      {/* The pane frames the SERVING origin, so the page arrives under its own
          sandbox CSP and the share page's chrome does not wrap it twice. */}
      <Tool label="Open beside your work" onClick={() => openBrowserPane({ kind: "url", url: pageFrameSrc(slug) })}>
        <Columns2 className="h-3.5 w-3.5" />
      </Tool>
      <Tool label="Open in a new tab" onClick={() => window.open(pageShareUrl(slug), "_blank", "noopener,noreferrer")}>
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Tool>
    </>
  );
}

/** The frameless page: the body on the thread's own surface, the toolbar
 *  floating over its top corner, the resize edge under it, the caption
 *  below. Folded (`collapsed`), it is the title row alone. All spans, so it
 *  stays valid wherever markdown puts it. */
export function FramelessPage({ title, href, actions, status, statusPinned, caption, height, stageRef, loaded, pinning, grip, collapsed, onToggleCollapsed, children }: {
  title: string;
  href: string;
  actions: ReactNode;
  /** A quiet status beside the title in the toolbar. */
  status?: ReactNode;
  /** Also hold the status on the page's top edge while the toolbar is away:
   *  for a state worth seeing without reaching for the page. */
  statusPinned?: boolean;
  caption?: string;
  height: number | string;
  stageRef?: RefObject<HTMLSpanElement | null>;
  /** The body has painted; until then a quiet shimmer holds its place. */
  loaded: boolean;
  pinning?: boolean;
  grip?: ReactNode;
  /** Given with `onToggleCollapsed`, the toolbar carries a fold verb. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  children: ReactNode;
}) {
  const titleLink = (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-full py-0.5 pl-1 pr-2 text-[11px] font-medium text-sol-text-secondary no-underline transition-colors hover:text-sol-text"
      title={href}
    >
      <PageFavicon className="h-4 w-4" />
      <span className="truncate">{title}</span>
    </a>
  );

  if (collapsed && onToggleCollapsed) {
    return (
      <span className="page-embed page-embed--collapsed not-prose mb-5 block">
        <span className="page-embed__fold">
          <button type="button" onClick={onToggleCollapsed} className={TOOL} aria-label={`Show ${title}`} title="Show the page">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          {titleLink}
        </span>
        {caption && <span className="mt-1.5 block text-[11px] leading-snug text-sol-text-muted">{caption}</span>}
      </span>
    );
  }

  return (
    <span
      className="page-embed not-prose mb-5 block"
      data-loaded={loaded ? "" : undefined}
      data-pinning={pinning ? "" : undefined}
    >
      <span className="relative block">
        <span className="page-embed__edge" aria-hidden />
        <span ref={stageRef} className="page-embed__stage relative block overflow-hidden rounded-[10px]" style={{ height }}>
          {children}
          {!loaded && <span className="page-embed__shimmer" aria-hidden />}
        </span>
        <TooltipProvider delayDuration={350} skipDelayDuration={150}>
          <span className="page-embed__bar" role="toolbar" aria-label={`${title} actions`}>
            {titleLink}
            {status}
            <span className="mx-0.5 h-3.5 w-px flex-shrink-0 bg-sol-border/50" aria-hidden />
            {actions}
            {onToggleCollapsed && (
              <Tool label="Collapse" onClick={onToggleCollapsed}>
                <ChevronDown className="h-3.5 w-3.5" />
              </Tool>
            )}
          </span>
        </TooltipProvider>
        {statusPinned && status && <span className="page-embed__status" aria-hidden>{status}</span>}
        {grip}
      </span>
      {caption && <span className="mt-1.5 block text-[11px] leading-snug text-sol-text-muted">{caption}</span>}
    </span>
  );
}

const EMBED_HEIGHT = 420;
// Expanding doubles the frame.
const EMBED_EXPAND_FACTOR = 2;
// The frame height a reader drags to, kept across embeds and reloads.
const EMBED_HEIGHT_KEY = "codecast.pageEmbed.height";
const EMBED_MIN_HEIGHT = 120;

/** The height a framed published page reports its content needs (see
 *  shared/render/pageTheme.ts). Null until the page reports, and for a report
 *  too small to be a real layout (a page whose content is all absolutely
 *  positioned measures its body at a few pixels). */
function useReportedHeight(frameRef: RefObject<HTMLIFrameElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useWatchEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: unknown; height?: unknown } | null;
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      if (m?.type !== PAGE_HEIGHT_MESSAGE || typeof m.height !== "number" || !Number.isFinite(m.height)) return;
      if (m.height < EMBED_MIN_HEIGHT) return;
      setHeight(Math.round(m.height));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef]);
  return height;
}

/**
 * Block-level inline embed of a published page, frameless in the thread.
 * Rendered for a publish URL standing alone on its own line in message
 * markdown, and for decision-queue report attachments.
 */
export function PublishedPageEmbed({ slug, caption, height }: {
  slug: string;
  caption?: string;
  /** A shorter frame where the page is a slice of something else (a decision
   *  card in a list), not the page's own surface. */
  height?: number;
}) {
  const meta = usePageMeta(slug);
  const [expanded, setExpanded] = useState(false);
  // Folded, the frame unmounts: a page out of sight should not keep running.
  const [collapsed, setCollapsed] = useState(false);
  // The height this frame was dragged to becomes its short height.
  const [dragged, setDragged] = useState<number | null>(null);
  const onResized = useCallback((h: number) => {
    setDragged(h);
    setExpanded(false);
  }, []);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLSpanElement>(null);
  // Short by default: the given height (a slice inside a decision card), else
  // the reader's saved one. Expanding doubles it. Neither runs past the page's
  // own content, so a short page sits snug and has nothing to expand.
  const reported = useReportedHeight(frameRef);
  const [fallback] = useState(() => height ?? savedGripHeight(EMBED_HEIGHT_KEY, EMBED_MIN_HEIGHT) ?? EMBED_HEIGHT);
  const base = dragged ?? fallback;
  const content = reported ?? Infinity;
  const canExpand = content > base;
  const frameHeight = Math.min(content, expanded && canExpand ? base * EMBED_EXPAND_FACTOR : base);
  const { theme, onLoad: onThemeLoad } = useFrameTheme(frameRef, { blend: true });
  const notes = usePageNotes(frameRef, slug, meta?.title || "Published page");
  // The page paints the server's default palette until the theme message
  // lands, so it fades in a beat after load rather than flashing.
  const [loaded, setLoaded] = useState(false);
  const onLoad = useCallback(() => {
    onThemeLoad();
    notes?.onLoad();
    setTimeout(() => setLoaded(true), 90);
  }, [onThemeLoad, notes?.onLoad]); // eslint-disable-line react-hooks/exhaustive-deps
  // The theme at mount rides the address so the first paint already matches;
  // later changes arrive as messages, because a new src would reload the page.
  // embed=1 tells the page this window carries its chrome.
  const [mountTheme] = useState(theme);
  // A newer version reloads the frame by itself: the version the frame first
  // showed stays the base, and each version above it is a new address (which
  // also busts the 60s cache in front of the page).
  const version = meta?.version ?? 0;
  const [baseVersion, setBaseVersion] = useState(0);
  if (!baseVersion && version) setBaseVersion(version);
  const src = `${pageFrameSrc(slug)}?theme=${mountTheme}&embed=1${baseVersion && version > baseVersion ? `&r=v${version}` : ""}`;
  const agent = usePageAgent(slug, !collapsed && !!meta && !meta.gated);

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
    <FramelessPage
      title={title}
      href={pageShareUrl(slug)}
      caption={caption}
      height={frameHeight}
      stageRef={stageRef}
      loaded={loaded}
      pinning={notes?.pinMode}
      status={agent ? <PageAgentStatus agent={agent} /> : undefined}
      statusPinned={!!agent && agent.chip !== "idle"}
      collapsed={collapsed}
      onToggleCollapsed={() => {
        setLoaded(false);
        setCollapsed((v) => !v);
      }}
      actions={<PublishedPageActions slug={slug} expanded={expanded} onToggleExpand={canExpand ? () => setExpanded((v) => !v) : undefined} notes={notes} />}
      grip={
        <span className="page-embed__grip" onDoubleClick={() => { setDragged(null); setExpanded(false); }} title="Drag to resize, double-click to fit">
          <HeightGrip target={stageRef} storageKey={EMBED_HEIGHT_KEY} min={EMBED_MIN_HEIGHT} onResized={onResized} />
        </span>
      }
    >
      <iframe
        ref={frameRef}
        src={src}
        onLoad={onLoad}
        className="page-embed__frame block h-full w-full"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        title={title}
      />
    </FramelessPage>
  );
}

/** Tiny "favicon" disc: the published page's identity mark. Every flat accent
 *  pill already names an internal object (blue session, cyan plan, green doc,
 *  violet project…), so a page — a link OUT to the web — gets a duotone disc
 *  no entity owns instead of another accent from the same family. */
export function PageFavicon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-sol-cyan/35 to-sol-violet/35 ${className}`}
    >
      <LinkIcon className="h-[62%] w-[62%] text-sol-text" />
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

/** A Claude artifact in the thread is a page the reader cannot see in place.
 *  The fix is on their side: with the Publish feature on, their agents put
 *  deliverables on codecast pages, which the thread frames live. So the card
 *  offers it (useFeatureOffer decides who sees the offer). */
const PUBLISH_REASON = "Turn on Publish and your agents put pages like this on codecast, where the thread shows them live.";

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
            {canPane
              ? "claude.ai does not let other sites frame an artifact. Open it in its own tab, or as a pane beside this conversation."
              : "claude.ai does not let other sites frame an artifact, so it opens in its own tab."}
          </span>
          <span className="truncate font-mono text-[10px] text-sol-text-dim">claude.ai/public/artifacts/{id}</span>
        </span>
        <ArrowUpRight className="ml-auto h-3.5 w-3.5 flex-shrink-0 text-sol-text-dim transition-transform group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-sol-orange" />
      </a>
      <FeatureUpsell slug="publish" variant="inline" reason={PUBLISH_REASON} />
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

// ---------------------------------------------------------------------------
// Any other web page: a preview drawn from the page's own meta tags
// ---------------------------------------------------------------------------

type LinkPreviewRow = {
  url: string;
  status: "pending" | "ok" | "failed";
  title?: string;
  description?: string;
  image?: string;
  site_name?: string;
  favicon?: string;
  requested_at: number;
  fetched_at?: number;
};

/** The page's preview row, asking the server to read the page when it has
 *  none or it has gone stale. Enrichment only: the card renders the bare
 *  address until the row arrives. */
function useLinkPreview(url: string): LinkPreviewRow | null | undefined {
  const { data } = useQueryNoThrow(api.linkPreviews.get, { url });
  const request = useMutation(api.linkPreviews.request);
  const row = data as LinkPreviewRow | null | undefined;
  const stale = row !== undefined && linkPreviewStale(row, Date.now());
  useWatchEffect(() => {
    if (stale) void request({ url }).catch(() => {});
  }, [stale, url, request]);
  return row;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A web link standing alone on its line: site, title, description and the
 *  page's share image, the way chat apps unfurl a link. Until the page has
 *  been read (or when it has no tags) it is the same card carrying the
 *  address, so the message never jumps from a link to a card. */
export function LinkPreviewCard({ url, caption }: { url: string; caption?: string }) {
  const row = useLinkPreview(url);
  const ok = row?.status === "ok" ? row : null;
  const [iconFailed, setIconFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const host = hostLabel(url);
  const site = ok?.site_name && ok.site_name.toLowerCase() !== host ? `${host} · ${ok.site_name}` : host;
  const image = ok?.image && !imageFailed ? ok.image : null;
  return (
    <span className="not-prose my-2 block max-w-xl">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={url}
        className="group flex gap-3 rounded-md border border-sol-border border-l-[3px] border-l-sol-border bg-sol-bg-alt py-2 pl-3 pr-2 no-underline transition-colors hover:border-l-sol-blue hover:bg-sol-card"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-sol-text-dim">
            {ok?.favicon && !iconFailed ? (
              <img src={ok.favicon} alt="" className="h-3.5 w-3.5 flex-shrink-0 rounded-sm" onError={() => setIconFailed(true)} />
            ) : (
              <LinkIcon className="h-3 w-3 flex-shrink-0" />
            )}
            <span className="truncate">{site}</span>
            <ArrowUpRight className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </span>
          {ok?.title ? (
            <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-sol-blue group-hover:underline">{ok.title}</span>
          ) : (
            <span className="truncate font-mono text-[11px] text-sol-text-muted">{url.replace(/^https?:\/\//, "")}</span>
          )}
          {ok?.description && (
            <span className="line-clamp-2 text-xs leading-snug text-sol-text-muted">{ok.description}</span>
          )}
        </span>
        {image && (
          <img
            src={image}
            alt=""
            loading="lazy"
            className="h-[72px] w-[128px] flex-shrink-0 self-center rounded border border-sol-border object-cover"
            onError={() => setImageFailed(true)}
          />
        )}
      </a>
      {caption && <span className="mt-1 block text-[11px] leading-snug text-sol-text-muted">{caption}</span>}
    </span>
  );
}
