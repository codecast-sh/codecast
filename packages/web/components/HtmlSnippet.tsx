import { useRef, useState, useMemo, useCallback, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import DOMPurify from "dompurify";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { toast } from "sonner";
import { copyToClipboard } from "../lib/utils";
import { Copy, Check, Maximize2, X, Code2, Eye } from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import { hasCharts, hydrateCharts } from "../lib/castChart";

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
// codecast from declarative data, never by agent code.)

const PURIFY_CONFIG = {
  // DOMPurify keeps these by default; we don't want embeds, forms, external
  // stylesheets, or <base>/<meta> rewrites in untrusted content.
  FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "meta", "link"],
  FORBID_ATTR: ["ping", "formaction"],
  ADD_ATTR: ["target"],
};

// Force links to open in a new tab without an opener, rather than hijacking the
// codecast SPA. Installed once, globally.
let hookInstalled = false;
function ensureHooks() {
  if (hookInstalled) return;
  hookInstalled = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if ((node as Element).tagName === "A" && (node as Element).getAttribute("href")) {
      (node as Element).setAttribute("target", "_blank");
      (node as Element).setAttribute("rel", "noopener noreferrer");
    }
  });
}

function sanitize(code: string): string {
  ensureHooks();
  return DOMPurify.sanitize(code, PURIFY_CONFIG);
}

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
  ".cast-chart figure>div{margin-bottom:14px!important;color:var(--sol-text-secondary)}";

// The canvas's title for the header — an explicit data-canvas-title, else the
// first heading. Lets the header show what the canvas IS rather than "Canvas".
function extractTitle(html: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const clip = (s: string) => (s.length > 80 ? s.slice(0, 79) + "…" : s);
    const explicit = doc.querySelector("[data-canvas-title]")?.getAttribute("data-canvas-title")?.trim();
    if (explicit) return clip(explicit);
    const heading = doc.querySelector("h1,h2,h3,h4,h5,h6")?.textContent?.trim();
    if (heading) return clip(heading);
    // Fall back to a short leading label (the uppercase eyebrow many canvases use).
    const lead = doc.body.firstElementChild?.firstElementChild;
    if (lead && lead.children.length === 0) {
      const t = lead.textContent?.trim();
      if (t && t.length <= 64) return clip(t);
    }
    return null;
  } catch {
    return null;
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

  useWatchEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!rootRef.current) {
      rootRef.current = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    }
    const root = rootRef.current;
    root.innerHTML = `<style>${SHADOW_BASE}</style>${html}`;
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

export function HtmlSnippet({ code }: { code: string }) {
  const debounced = useDebounced(code, 150);
  const clean = useMemo(() => sanitize(debounced), [debounced]);
  const title = useMemo(() => extractTitle(clean), [clean]);
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

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
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  if (!code.trim()) return null;

  const headerBtn =
    "p-1 rounded text-sol-text-dim/70 hover:text-sol-text-secondary hover:bg-sol-bg-highlight/50 transition-colors";

  return (
    <div className="my-3 overflow-hidden rounded border border-sol-border/40 bg-sol-bg-alt">
      <div className="flex items-center justify-between gap-2 border-b border-sol-border/40 px-3 py-1.5">
        <span
          className={`truncate text-xs font-medium ${title ? "text-sol-text-muted" : "uppercase tracking-wide text-sol-text-dim/70 text-[11px]"}`}
          title={title ?? undefined}
        >
          {title ?? "Canvas"}
        </span>
        <div className="flex items-center gap-0.5">
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
        <ShadowCanvas html={clean} className="px-5 py-4" />
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
              <ShadowCanvas html={clean} className="w-full max-w-5xl" />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
