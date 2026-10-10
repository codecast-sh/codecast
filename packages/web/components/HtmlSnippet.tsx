import { useRef, useState, useMemo, type ReactNode } from "react";
import { sanitizeCanvasHtml } from "../lib/canvasSanitize";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { CodeBlock } from "./CodeBlock";
import { BlockFrame } from "./BlockFrame";
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

/** What a canvas element marked `data-press` or `data-change` hands its owner: the name, the element's other data-* values, and an input's value. */
export type CanvasEvent = { kind: "press" | "change"; name: string; data: Record<string, string>; value?: string };

/** Renders sanitized HTML into a Shadow DOM so its styles are encapsulated. `onEvent` makes it interactive: the markup carries no handlers, only names. */
export function ShadowCanvas({ html, className = "", onEvent }: { html: string; className?: string; onEvent?: (e: CanvasEvent) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<ShadowRoot | null>(null);
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

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
        if (route) {
          me.preventDefault();
          routerRef.current.push(route);
          return;
        }
        const pressed = (me.target as Element | null)?.closest?.("[data-press]") as HTMLElement | null;
        if (pressed && onEventRef.current) {
          me.preventDefault();
          const { press, ...data } = pressed.dataset;
          onEventRef.current({ kind: "press", name: press!, data: data as Record<string, string> });
        }
      });
      rootRef.current.addEventListener("change", (e: Event) => {
        const el = (e.target as Element | null)?.closest?.("[data-change]") as HTMLInputElement | null;
        if (!el || !onEventRef.current) return;
        const { change, ...data } = el.dataset;
        const value = el.type === "checkbox" ? String(el.checked) : el.value;
        onEventRef.current({ kind: "change", name: change!, data: data as Record<string, string>, value });
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

  return <div className={className} style={{ contain: "layout paint", isolation: "isolate", position: "relative" }}><div ref={hostRef} /></div>;
}

// The fence language the canvas claims. Owned here so every markdown dispatcher
// (MarkdownRenderer + ConversationView's renderMarkdownPre) stays in sync without
// duplicating the conditional.
export const CANVAS_FENCE = "cast-canvas";

/** Whether a markdown body holds a canvas fence. A plain-text preview of such
 *  a body shows the canvas's raw HTML, so previews render it instead. */
export function hasCanvasFence(markdown: string): boolean {
  return markdown.includes("```" + CANVAS_FENCE);
}

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
  if (!code.trim()) return null;
  return (
    <BlockFrame
      title={title}
      source={<CodeBlock code={code} language="html" />}
      copyText={code}
      copyLabel="Copy HTML"
      wide={wide}
      measureKey={clean}
      fullscreen={() => <ShadowCanvas html={clean} className="w-full" />}
    >
      <ShadowCanvas html={clean} className="px-5 py-4" />
    </BlockFrame>
  );
}
