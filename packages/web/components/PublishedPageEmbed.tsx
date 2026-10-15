import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Link as LinkIcon, Link2, ArrowUpRight, Check, ChevronDown, ChevronUp, ChevronsDownUp, ChevronsUpDown, Columns2, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { usePageInfo } from "../hooks/usePageInfo";
import { hasStoredAuthToken } from "../lib/localAuth";
import { adoptFrame, claimFrame, frameKey, frameLoaded, hasParkedFrame, makePageFrame, placeFrame, preloadFrame, releaseFrame, type PageHeight } from "../lib/pageFramePool";
import { useTheme } from "./ThemeProvider";
import { linkPreviewStale } from "@codecast/convex/convex/lib/linkPreviewMeta";
import { PAGE_GATE_MESSAGE, PAGE_HEIGHT_MESSAGE } from "../../shared/render/pageTheme";
import { useEventListener } from "../hooks/useEventListener";
import { useFrameTheme } from "../hooks/useFrameTheme";
import { usePageNotes } from "../hooks/usePageNotes";
import { sessionName, usePageAgent, type PageAgent } from "../hooks/usePageAgent";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { useInboxStore } from "../store/inboxStore";
import { MessageIdentity } from "../lib/conversationBlockContexts";
import { PAGE_AGENT_LABELS } from "@codecast/shared/contracts";
import { useNativeBrowserPane } from "../hooks/useNativeBrowserPane";
import { copyToClipboard } from "../lib/utils";
import { isDesktop } from "../lib/desktop";
import { openBrowserPane } from "../lib/stage";
import { pageEmbedSrc, pageFrameSrc, pageShareUrl } from "../lib/publishedPageUrls";
import { claudeArtifactUrl, entityRoute } from "../lib/entityLinks";
import { FeatureUpsell } from "./agentFeatures/FeatureUpsell";
import { ClaudeIcon } from "./BrandIcons";
import { HeightGrip } from "./HeightGrip";
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


/** The page's agent, as a quiet chip: the publishing session's name and its
 *  state, the dot breathing while the agent is on the page. The same state the
 *  page's own bar shows. A link to that session. */
function PageAgentStatus({ agent }: { agent: PageAgent }) {
  const openLinkedSession = useOpenLinkedSession();
  const tone =
    agent.chip === "needs_input" ? "text-sol-yellow" :
    agent.chip === "updating" ? "text-sol-red" :
    agent.chip === "working" ? "text-sol-blue" : "text-sol-text-dim";
  const busy = agent.chip === "working" || agent.chip === "updating";
  const name = sessionName(agent) ?? agent.session?.short_id ?? "Session";
  const convId = agent.session?.conversation_id ?? null;
  const href = convId ? entityRoute("session", convId) : null;
  const body = (
    <>
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full bg-current ${busy ? "page-embed__agent-dot--busy" : "opacity-70"}`} aria-hidden />
      <span className="max-w-[16ch] truncate">{name}</span>
      <span className="opacity-70">{PAGE_AGENT_LABELS[agent.chip]}</span>
    </>
  );
  const className = `page-embed__agent inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap px-1.5 font-mono text-[10.5px] ${tone}`;
  const title = agent.chip === "updating"
    ? "A comment was sent to the session that made this page; it reloads here when a new version lands."
    : agent.session?.title || "The session that made this page.";
  if (!href) return <span className={className} role="status" title={title}>{body}</span>;
  return (
    <a
      href={href}
      className={`${className} hover:underline`}
      role="status"
      title={title}
      onClick={(e) => {
        // A session already in the store takes the stage like any session
        // reference; anything else (or a modified click) follows the href.
        const row = convId ? useInboxStore.getState().sessions[convId] : null;
        if (!row || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openLinkedSession(row);
      }}
    >
      {body}
    </a>
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
export function FramelessPage({ title, href, actions, status, statusPinned, caption, height, stageRef, loaded, pinning, grip, collapsed, onToggleCollapsed, bare = false, children }: {
  title: string;
  href: string;
  actions: ReactNode;
  /** The page is part of the surface around it (a decision's own page): no toolbar, no fold, no resize edge. */
  bare?: boolean;
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
            <ChevronDown className="h-3.5 w-3.5" />
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
          {!loaded && <span className="page-embed__shimmer" role="status"><span className="page-embed__loading">Loading the page</span></span>}
        </span>
        {!bare && <TooltipProvider delayDuration={350} skipDelayDuration={150}>
          <span className="page-embed__bar" role="toolbar" aria-label={`${title} actions`}>
            {titleLink}
            {status}
            <span className="mx-0.5 h-3.5 w-px flex-shrink-0 bg-sol-border/50" aria-hidden />
            {actions}
            {onToggleCollapsed && (
              <Tool label="Collapse" onClick={onToggleCollapsed}>
                <ChevronUp className="h-3.5 w-3.5" />
              </Tool>
            )}
          </span>
        </TooltipProvider>}
        {statusPinned && status && <span className="page-embed__status" aria-hidden>{status}</span>}
        {!bare && grip}
      </span>
      {caption && <span className="mt-1.5 block text-[11px] leading-snug text-sol-text-muted">{caption}</span>}
    </span>
  );
}

const EMBED_HEIGHT = 420;
// Expanding doubles the frame.
const EMBED_EXPAND_FACTOR = 2;
const EMBED_MIN_HEIGHT = 120;
// The tallest a page may ask to open at.
const EMBED_MAX_PREFERRED = 2000;

/** The height a framed published page reports its content needs, and the
 *  height it asks to open at (`<meta name="codecast:height">`; see
 *  shared/render/pageTheme.ts). Null until the page reports; a content height
 *  too small to be a real layout (a page whose content is all absolutely
 *  positioned measures its body at a few pixels) is ignored. */
function useReportedHeight(frameRef: RefObject<HTMLIFrameElement | null>) {
  const [height, setHeight] = useState<{ content: number | null; preferred: number | null }>({ content: null, preferred: null });
  const take = useCallback((m: { type?: unknown; height?: unknown; preferred?: unknown } | null) => {
    if (m?.type !== PAGE_HEIGHT_MESSAGE || typeof m.height !== "number" || !Number.isFinite(m.height)) return;
    if (m.height < EMBED_MIN_HEIGHT) return;
    const content = Math.round(m.height);
    const preferred = typeof m.preferred === "number" && Number.isFinite(m.preferred)
      ? Math.min(EMBED_MAX_PREFERRED, Math.max(EMBED_MIN_HEIGHT, Math.round(m.preferred)))
      : null;
    setHeight((h) => (h.content === content && h.preferred === preferred ? h : { content, preferred }));
  }, []);
  useWatchEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      take(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef]);
  // A frame moved back from the pool reports nothing new: replay the last height it reported.
  const replay = useCallback((h: PageHeight) => take({ type: PAGE_HEIGHT_MESSAGE, ...h }), [take]);
  return { ...height, replay };
}

/** The page's iframe. A frame for the same page parked a moment ago (lib/pageFramePool) is moved in still loaded;
 *  otherwise the embed renders its own, which the pool adopts, and either way the frame is parked on unmount for the
 *  next embed of that page. Keyed by `src` by its parent: a new address is a new frame. */
function PooledFrame({ src, poolKey, title, frameRef, onLoad, onHeight }: {
  src: string;
  /** The page version this address shows (frameKey), null while unconfirmed: what the pool keeps the frame under. */
  poolKey: string | null;
  title: string;
  frameRef: RefObject<HTMLIFrameElement | null>;
  onLoad: () => void;
  onHeight: (h: PageHeight) => void;
}) {
  const slotRef = useRef<HTMLSpanElement>(null);
  const ownRef = useRef<HTMLIFrameElement>(null);
  const keyRef = useRef(poolKey);
  keyRef.current = poolKey;
  const loadRef = useRef(onLoad);
  loadRef.current = onLoad;
  // Decided once, at mount: render a frame of our own unless one waits parked.
  const [parkedAtMount] = useState(() => hasParkedFrame(poolKey));
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const claimed = claimFrame(keyRef.current);
    // A frame was parked at render but another embed of the same page took it first: this one builds its own.
    const built = !claimed && !ownRef.current ? makePageFrame(src) : null;
    const frame = claimed?.frame ?? ownRef.current ?? built;
    if (!frame) return;
    if (built) {
      slot.appendChild(built);
      adoptFrame(built, false);
    } else if (claimed) {
      // Parked within this same commit (the embed remounted): the parked frame is further along than the one this
      // render started, so that one stops and leaves. React only removes the slot around it, never the frame itself.
      const own = ownRef.current;
      if (own && own !== frame) {
        own.src = "about:blank";
        own.remove();
      }
      placeFrame(frame, slot);
    } else adoptFrame(frame);
    frame.title = title;
    (frameRef as { current: HTMLIFrameElement | null }).current = frame;
    const onFrameLoad = () => { frameLoaded(frame); loadRef.current(); };
    frame.addEventListener("load", onFrameLoad);
    if (claimed?.height) onHeight(claimed.height);
    if (claimed?.loaded) loadRef.current();
    return () => {
      frame.removeEventListener("load", onFrameLoad);
      if (frameRef.current === frame) (frameRef as { current: HTMLIFrameElement | null }).current = null;
      releaseFrame(frame, keyRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={slotRef} className="block h-full w-full">
      {!parkedAtMount && (
        <iframe
          ref={ownRef}
          src={src}
          className="page-embed__frame block h-full w-full"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          title={title}
        />
      )}
    </span>
  );
}

/**
 * Block-level inline embed of a published page, frameless in the thread.
 * Rendered for a publish URL standing alone on its own line in message
 * markdown, and for decision-queue report attachments.
 */
/** True where a column is too narrow to frame a page (a chat beside the page it is about): a published page reads as its link there. */
export const PublishedPagesAsLinks = createContext(false);

type PublishedPageEmbedProps = {
  slug: string;
  caption?: string;
  /** A shorter frame where the page is a slice of something else (a decision
   *  card in a list), not the page's own surface. */
  height?: number;
  /** The decision this page was filed on (its report or an option's page): whoever may read that decision opens a gated
   *  page here as its owner does. */
  decision?: string | null;
  /** The page is the surface's subject: the frame grows to the page's whole height once it reports it, so it reads in
   *  the host's own scroll instead of a box that scrolls inside it, and carries no chrome of its own (the surface has
   *  its own ways to open and share it). `height` holds its place until then. */
  whole?: boolean;
  /** Called once the page is in view (its frame loaded), or once it is known it will not frame (deleted, locked). */
  onReady?: () => void;
};

export function PublishedPageEmbed(props: PublishedPageEmbedProps) {
  const asLink = useContext(PublishedPagesAsLinks);
  return asLink ? <PublishedPagePill slug={props.slug} href={pageShareUrl(props.slug)} /> : <PublishedPageFrame {...props} />;
}

function PublishedPageFrame({ slug, caption, height, decision, whole = false, onReady }: PublishedPageEmbedProps) {
  // The page's info (title, version, its gates) paints from the store, so a page seen before frames at once. A page
  // never seen starts loading anyway, with no gate tokens, hidden until its info arrives: an open page is then
  // already there, and a gated one reloads with the tokens a signed-in reader may hold. A guest frames at once: a
  // gated page's password form is what a guest should see.
  const { info, keys } = usePageInfo(slug, decision);
  const guest = useMemo(() => !hasStoredAuthToken(), []);
  const confirmed = !!info || guest;
  const locked = !!info?.locked;
  const meta = info && !info.missing && !info.locked ? info : undefined;
  const [expanded, setExpanded] = useState(false);
  // Folded, the frame unmounts: a page out of sight should not keep running.
  const [collapsed, setCollapsed] = useState(false);
  // A drag sizes this frame alone: every other embed still opens short. A
  // drag past the short height reads as expanded, so Shrink undoes it.
  const [dragged, setDragged] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLSpanElement>(null);
  // Short by default: the given height (a slice inside a decision card), else
  // the height the page asks for, else EMBED_HEIGHT. Expanding doubles it.
  // Neither runs past the page's own content, so a short page sits snug and
  // has nothing to expand.
  const { content: reported, preferred, replay: replayHeight } = useReportedHeight(frameRef);
  const short = height ?? preferred ?? EMBED_HEIGHT;
  const content = reported ?? Infinity;
  const tall = dragged != null ? dragged > short : expanded;
  const canToggle = tall || content > short;
  const toggleExpand = () => {
    setExpanded(!tall);
    setDragged(null);
  };
  const frameHeight = whole && reported && dragged == null ? reported : Math.min(content, dragged ?? (expanded ? short * EMBED_EXPAND_FACTOR : short));
  const { theme, onLoad: onThemeLoad } = useFrameTheme(frameRef, { blend: true });
  const notes = usePageNotes(frameRef, slug, meta?.title || "Published page");
  // The page is shown the moment it is there: the frame's own load event, or
  // the page reporting its painted height, whichever comes first. Neither waits
  // on a timer, which a background tab holds back for a minute; the theme rides
  // the address, so the first paint already matches. What loaded is the address
  // it loaded, so a frame started before the page's info was known shows only
  // once that info says it was the right address.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const srcRef = useRef("");
  const onLoad = useCallback(() => {
    onThemeLoad();
    notes?.onLoad();
    setLoadedSrc(srcRef.current);
  }, [onThemeLoad, notes?.onLoad]); // eslint-disable-line react-hooks/exhaustive-deps
  useWatchEffect(() => { if (reported) setLoadedSrc(srcRef.current); }, [reported]);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  // The theme at mount rides the address so the first paint already matches;
  // later changes arrive as messages, because a new src would reload the page.
  // embed=1 tells the page this window carries its chrome.
  const [mountTheme] = useState(theme);
  // The address is pinned to the page's version (r=vN) whenever the version
  // was known at mount, so the browser keeps it for the whole bound and a
  // newer version is a new address that reloads the frame by itself. A page
  // never seen starts at the bare address, before its version is known, and
  // keeps it until a newer version arrives.
  const version = meta?.version ?? 0;
  const [mountVersion] = useState(version);
  const [baseVersion, setBaseVersion] = useState(version);
  if (!baseVersion && version) setBaseVersion(version);
  const src = pageEmbedSrc(slug, mountTheme, keys, mountVersion || version > baseVersion ? version : undefined);
  srcRef.current = src;
  // A frame started before the page's info arrived shows the moment it loads, unless what loaded was a gate (it says
  // so: PAGE_GATE_MESSAGE): then it waits for the info, which brings the tokens past it or says the reader has none.
  const [gateSrc, setGateSrc] = useState<string | null>(null);
  useEventListener("message", useCallback((e: MessageEvent) => {
    if (frameRef.current && e.source === frameRef.current.contentWindow && (e.data as { type?: unknown } | null)?.type === PAGE_GATE_MESSAGE) setGateSrc(srcRef.current);
  }, []));
  const loaded = loadedSrc === src && (confirmed || gateSrc !== src);
  const agent = usePageAgent(slug, !collapsed && !!meta && !meta.gated);
  // Idle says nothing the reader can use, and inside the publishing session's
  // own thread the thread already shows its state.
  const thread = useContext(MessageIdentity)?.conversationId;
  const showAgent = !!agent && agent.chip !== "idle" && !(thread && thread === agent.session?.conversation_id);
  useWatchEffect(() => { if (loaded) readyRef.current?.(); }, [loaded]);

  // Deleted or never existed: a full-height frame of a 404 reads as breakage. A gated page the viewer cannot
  // open here would frame a password form. Both degrade to a compact note carrying the link.
  if (info?.missing || locked) {
    return (
      <ReadyNow onReady={onReady}>
      <span className="not-prose my-3 flex max-w-md flex-col gap-1 rounded-md border border-dashed border-sol-border bg-sol-bg-alt px-3 py-2 text-xs" data-page-embed-note={locked ? "locked" : "missing"}>
        <span className="text-sol-text-dim">{locked ? "Protected page: open it to enter its password" : "Published page unavailable"}</span>
        <a
          href={pageShareUrl(slug)}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-sol-text-dim hover:text-sol-blue"
        >
          {pageShareUrl(slug)}
        </a>
      </span>
      </ReadyNow>
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
      status={showAgent ? <PageAgentStatus agent={agent} /> : undefined}
      statusPinned={showAgent}
      bare={whole}
      collapsed={collapsed}
      onToggleCollapsed={() => {
        setLoadedSrc(null);
        setCollapsed((v) => !v);
      }}
      actions={<PublishedPageActions slug={slug} expanded={tall} onToggleExpand={canToggle && !(whole && reported) ? toggleExpand : undefined} notes={notes} />}
      grip={
        <span className="page-embed__grip" onDoubleClick={() => { setDragged(null); setExpanded(false); }} title="Drag to resize, double-click to fit">
          <HeightGrip target={stageRef} min={EMBED_MIN_HEIGHT} onResized={setDragged} />
        </span>
      }
    >
      <PooledFrame key={src} src={src} poolKey={confirmed ? frameKey(src, meta?.version) : null} title={title} frameRef={frameRef} onLoad={onLoad} onHeight={replayHeight} />
    </FramelessPage>
  );
}

/** Loads a page the reader is likely to open next into a parked frame (lib/pageFramePool), so its embed shows it
 *  loaded the moment it mounts. Renders nothing. */
export function PreloadPublishedPage({ slug, decision }: { slug: string; decision?: string | null }) {
  const { info, keys } = usePageInfo(slug, decision);
  const { theme } = useTheme();
  const version = info && !info.missing && !info.locked ? info.version : undefined;
  useWatchEffect(() => {
    if (!version) return;
    const src = pageEmbedSrc(slug, theme, keys, version);
    // Roughly the width a thread or a decision shows a page at; a different one only re-lays it out on arrival.
    preloadFrame(src, frameKey(src, version), Math.min(900, window.innerWidth * 0.6));
  }, [slug, theme, keys, version]);
  return null;
}

/** Says a page that will not frame is as ready as it gets, once, on mount. */
function ReadyNow({ onReady, children }: { onReady?: () => void; children: ReactNode }) {
  useWatchEffect(() => { onReady?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <>{children}</>;
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
  const { info: meta } = usePageInfo(slug);
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
    <span className="not-prose my-2 block">
      <span className="group/link flex items-start gap-1">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={url}
          className="group flex min-w-0 max-w-xl flex-1 gap-3 rounded-md border border-sol-border border-l-[3px] border-l-sol-border bg-sol-bg-alt py-2 pl-3 pr-2 no-underline transition-colors hover:border-l-sol-blue hover:bg-sol-card"
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
        <CopyLinkButton
          url={url}
          title="Copy link"
          className="mt-1 flex-shrink-0 rounded p-1 text-sol-text-dim opacity-0 transition-opacity hover:text-sol-blue focus-visible:opacity-100 group-hover/link:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </span>
      {caption && <span className="mt-1 block text-[11px] leading-snug text-sol-text-muted">{caption}</span>}
    </span>
  );
}
