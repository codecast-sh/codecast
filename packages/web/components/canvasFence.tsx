import { Suspense, lazy, type ReactNode } from "react";

// What every markdown pipeline needs to know about canvases (is this a canvas
// fence, is this whole message HTML) without loading what draws one: the
// sanitizer (DOMPurify, css-tree) and the chart code live in HtmlSnippet,
// fetched on the first canvas or once the app goes idle.

type SnippetModule = typeof import("./HtmlSnippet");

let loaded: SnippetModule | null = null;
let loading: Promise<SnippetModule> | null = null;
function loadSnippet(): Promise<SnippetModule> {
  return (loading ??= import("./HtmlSnippet").then((m) => (loaded = m)));
}

const LazySnippet = lazy(() => loadSnippet().then((m) => ({ default: m.HtmlSnippet })));

if (typeof window !== "undefined") {
  setTimeout(() => {
    const idle = (window as any).requestIdleCallback as ((fn: () => void, o?: { timeout: number }) => void) | undefined;
    if (idle) idle(() => void loadSnippet(), { timeout: 10_000 });
    else void loadSnippet();
  }, 5_000);
}

/** A sanitized canvas for `code`; the drawing module is fetched on the first one if idle has not brought it in yet. */
export function CanvasSnippet({ code }: { code: string }) {
  if (loaded) return <loaded.HtmlSnippet code={code} />;
  return (
    <Suspense fallback={<div className="my-2 h-24 max-w-[860px] rounded-xl border border-sol-border/30 bg-sol-bg-alt/40" aria-busy />}>
      <LazySnippet code={code} />
    </Suspense>
  );
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
  if (language === CANVAS_FENCE && code) return <CanvasSnippet code={code} />;
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
  return looksLikeHtml(content) ? <CanvasSnippet code={content} /> : null;
}
