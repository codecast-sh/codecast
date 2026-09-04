import { useRef, useState, useMemo, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sanitizeCanvasHtml } from "../lib/canvasSanitize";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";
import { Copy, Check, Maximize2, X, Code2, Eye, ChevronDown, ChevronUp } from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import { hasCharts, hydrateCharts } from "../lib/castChart";
import { hydrateWidgets, WIDGET_BASE_CSS } from "../lib/castWidgets";
import { canvasHrefToRoute } from "../lib/canvasLinks";
import { useRouter } from "next/navigation";

// Inline visual canvas. The agent emits a ```cast-canvas fenced block holding
// static HTML/CSS/SVG; we sanitize it (DOMPurify strips scripts, event handlers,
// and risky embeds) and render it into a Shadow DOM.
//
// Why Shadow DOM + sanitize rather than a sandboxed iframe:
//  - Inheritance: fonts, text color, and --sol-* custom properties pierce the
//    shadow boundary, so the canvas matches codecast (incl. light/dark) for free.
//  - Encapsulation: the agent's <style> is scoped to the shadow root (can't leak
//    out and break the app); codecast's global .prose can't leak in and distort it.
//  - Performance: plain DOM nodes, not a browsing context — cheap to mount in the
//    virtualized message list, where an iframe per message would be ruinous.
// Security: conversations sync across a team, so canvases are untrusted. All
// script execution is stripped — there is no agent JS. (Charts are rendered by
// codecast from declarative data, never by agent code.) The sanitization policy
// lives in lib/canvasSanitize.ts so it stays testable without this component's
// UI dependencies.

// Injected into every shadow root: a scoped reset plus themed defaults. Inherited
// properties (font-family, line-height) cross the boundary automatically; color
// and accents are pinned to the live sol tokens so unstyled content looks native
// and follows light/dark.
const SHADOW_BASE =
  ":host{display:block;color:var(--sol-text);font-family:var(--font-mono),ui-monospace,monospace;line-height:1.5}" +
  "*{box-sizing:border-box}" +
  "a{color:var(--sol-blue)}" +
  "::selection{background:color-mix(in srgb, var(--sol-blue) 30%, transparent)}" +
  // Charts: force JetBrains Mono everywhere (Plot's HTML swatch legend ships its
  // own inline font; a stylesheet !important overrides it). Scoped to .cast-chart
  // so freeform canvases keep their own typography.
  ".cast-chart,.cast-chart *{font-family:var(--font-mono),ui-monospace,monospace!important}" +
  ".cast-chart figure{margin:0}" +
  ".cast-chart figure>div{margin-bottom:14px!important;color:var(--sol-text-secondary)}" +
  WIDGET_BASE_CSS;

// Inline canvases taller than this collapse behind a gradient with an expand
// control. A fixed pixel cap (not vh) keeps measured row heights stable in the
// virtualized message list.
const COLLAPSE_PX = 620;

// Canvas metadata parsed from the sanitized markup: the header title (explicit
// data-canvas-title, else the first heading) and the wide hint
// (data-canvas-size="wide"), which relaxes the fullscreen width cap for
// dashboards and other broad layouts.
function extractMeta(html: string): { title: string | null; wide: boolean } {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const wide = !!doc.querySelector('[data-canvas-size="wide"]');
    const clip = (s: string) => (s.length > 80 ? s.slice(0, 79) + "…" : s);
    const explicit = doc.querySelector("[data-canvas-title]")?.getAttribute("data-canvas-title")?.trim();
    if (explicit) return { title: clip(explicit), wide };
    const heading = doc.querySelector("h1,h2,h3,h4,h5,h6")?.textContent?.trim();
    if (heading) return { title: clip(heading), wide };
    // Fall back to a short leading label (the uppercase eyebrow many canvases use).
    const lead = doc.body.firstElementChild?.firstElementChild;
    if (lead && lead.children.length === 0) {
      const t = lead.textContent?.trim();
      if (t && t.length <= 64) return { title: clip(t), wide };
    }
    return { title: null, wide };
  } catch {
    return { title: null, wide: false };
  }
}

// During an active turn the fenced block streams in token by token; debounce so we
// don't re-sanitize + reflow on every chunk. It settles shortly after the stream stops.
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  useWatchEffect(() => {
    const t = setTimeout(() => setSettled(valueRef.current), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Renders sanitized HTML into a Shadow DOM so its styles are encapsulated. */
function ShadowCanvas({ html, className = "" }: { html: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<ShadowRoot | null>(null);
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useWatchEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!rootRef.current) {
      rootRef.current = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      // Links to codecast's own objects (conversations, tasks, docs, …)
      // navigate the SPA. The sanitizer forces target="_blank" on every canvas
      // anchor, which is right for external links but bounces our own deep
      // links out to a browser tab — in the desktop app, out of the app
      // entirely. Modified clicks keep the browser's new-tab default.
      rootRef.current.addEventListener("click", (e: Event) => {
        const me = e as MouseEvent;
        if (me.defaultPrevented || me.button !== 0 || me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
        const anchor = (me.target as Element | null)?.closest?.("a[href]");
        const route = canvasHrefToRoute(anchor?.getAttribute("href"));
        if (!route) return;
        me.preventDefault();
        routerRef.current.push(route);
      });
    }
    const root = rootRef.current;
    root.innerHTML = `<style>${SHADOW_BASE}</style>${html}`;
    // Widgets (tabs, sortable tables) get their behavior from OUR code — the
    // sanitized markup carries no handlers. Synchronous and cheap (querySelector
    // misses when the canvas has none).
    hydrateWidgets(root);
    // Charts (Observable Plot) hydrate after layout settles so we can size them to
    // the container; Plot is lazy-loaded, so it costs nothing unless a chart appears.
    if (hasCharts(root)) {
      const raf = requestAnimationFrame(() => {
        const width = (host.clientWidth || 600) - 24; // minus the p-3 padding
        void hydrateCharts(root, width);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [html]);

  return <div ref={hostRef} className={className} />;
}

// The fence language the canvas claims. Owned here so every markdown dispatcher
// (MarkdownRenderer + ConversationView's renderMarkdownPre) stays in sync without
// duplicating the conditional.
export const CANVAS_FENCE = "cast-canvas";

/** Returns a rendered canvas for a cast-canvas fence, else null (caller falls back to CodeBlock). */
export function tryRenderCanvas(language: string | undefined, code: string): ReactNode {
  if (language === CANVAS_FENCE && code) return <HtmlSnippet code={code} />;
  return null;
}

// Codecast's own structured envelopes (teammate sends, skill blocks, …) start
// with a tag too, but have dedicated renderers upstream — never treat them as
// an HTML document. Hyphenated custom tags (session-message, system-reminder,
// command-name) are already rejected by the tag regex below.
const NON_HTML_ENVELOPES = /^<(skill|context|image)\b/i;

/**
 * A message whose ENTIRE body is raw HTML (an agent or user emitted a
 * document/fragment without the cast-canvas fence). The markdown pipeline
 * escapes raw tags, so these read as garbled source unless rendered.
 */
export function looksLikeHtml(content: string): boolean {
  const t = content.trim();
  if (t.length < 12 || t[0] !== "<" || !t.endsWith(">")) return false;
  if (NON_HTML_ENVELOPES.test(t)) return false;
  // Opening doctype or a plain (non-hyphenated) tag name.
  if (!/^<(!doctype\s|[a-z][a-z0-9]*[\s/>])/i.test(t)) return false;
  if (typeof DOMParser === "undefined") return false;
  try {
    const doc = new DOMParser().parseFromString(t, "text/html");
    return (doc.body?.children.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Renders an all-HTML message body as a sanitized canvas, else null (caller falls back to markdown/plain text). */
export function tryRenderHtmlMessage(content: string): ReactNode {
  return looksLikeHtml(content) ? <HtmlSnippet code={content} /> : null;
}

export function HtmlSnippet({ code }: { code: string }) {
  const debounced = useDebounced(code, 150);
  const clean = useMemo(() => sanitizeCanvasHtml(debounced), [debounced]);
  const { title, wide } = useMemo(() => extractMeta(clean), [clean]);
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const clipRef = useRef<HTMLDivElement>(null);

  // Watch the canvas host's natural height (content can grow after mount — charts
  // hydrate async, tabs re-show panels) to decide whether the collapse control is
  // needed. The observer targets the host INSIDE the clipped container, because
  // the container's own box is capped and would never report growth.
  useWatchEffect(() => {
    const host = clipRef.current?.firstElementChild;
    if (!host || showSource) return;
    const ro = new ResizeObserver(() => {
      setOverflowing(((host as HTMLElement).offsetHeight ?? 0) > COLLAPSE_PX);
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [showSource, clean]);

  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }, [code]);

  // Esc closes fullscreen.
  useWatchEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  if (!code.trim()) return null;

  const collapsed = overflowing && !expanded;
  const headerBtn =
    "p-1 rounded text-sol-text-dim/70 hover:text-sol-text-secondary hover:bg-sol-bg-highlight/50 transition-colors";

  return (
    <div className="my-3 overflow-hidden rounded border border-sol-border/40 bg-sol-bg-alt">
      <div className="flex items-center justify-between gap-2 border-b border-sol-border/40 px-3 py-1.5">
        {title && (
          <span className="truncate text-xs font-medium text-sol-text-muted" title={title}>
            {title}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => setShowSource((v) => !v)}
            className={headerBtn}
            title={showSource ? "Show rendered" : "Show source"}
          >
            {showSource ? <Eye size={14} /> : <Code2 size={14} />}
          </button>
          <button onClick={handleCopy} className={headerBtn} title="Copy HTML">
            {copied ? <Check size={14} className="text-sol-cyan" /> : <Copy size={14} />}
          </button>
          <button onClick={() => setFullscreen(true)} className={headerBtn} title="Fullscreen">
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {showSource ? (
        <div className="px-1">
          <CodeBlock code={code} language="html" />
        </div>
      ) : (
        <>
          <div
            ref={clipRef}
            className="relative overflow-hidden"
            style={collapsed ? { maxHeight: COLLAPSE_PX } : undefined}
          >
            <ShadowCanvas html={clean} className="px-5 py-4" />
            {collapsed && (
              <div
                className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
                style={{ background: "linear-gradient(to bottom, transparent, var(--sol-bg-alt))" }}
              />
            )}
          </div>
          {overflowing && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex w-full items-center justify-center gap-1 border-t border-sol-border/40 py-1 text-[11px] text-sol-text-dim hover:bg-sol-bg-highlight/40 hover:text-sol-text-secondary transition-colors"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? "Collapse" : "Show all"}
            </button>
          )}
        </>
      )}

      {fullscreen &&
        createPortal(
          <div className="canvas-scroll fixed inset-0 z-[100] overflow-auto bg-sol-bg/95 backdrop-blur-xl">
            {title && (
              <div className="absolute left-4 top-4 z-10 max-w-[55%] truncate rounded-lg border border-sol-border/40 bg-sol-bg-alt/80 px-3 py-1.5 text-xs font-medium text-sol-text-muted backdrop-blur">
                {title}
              </div>
            )}
            <div className="absolute right-4 top-4 z-10 flex items-center gap-0.5 rounded-lg border border-sol-border/40 bg-sol-bg-alt/80 px-1 py-0.5 backdrop-blur">
              <button onClick={handleCopy} className={headerBtn} title="Copy HTML">
                {copied ? <Check size={16} className="text-sol-cyan" /> : <Copy size={16} />}
              </button>
              <button onClick={() => setFullscreen(false)} className={headerBtn} title="Close (Esc)">
                <X size={18} />
              </button>
            </div>
            <div className="flex min-h-full items-center justify-center p-8">
              <ShadowCanvas html={clean} className={`w-full ${wide ? "max-w-none" : "max-w-5xl"}`} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
