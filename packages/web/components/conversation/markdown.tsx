import { useMemo, memo, useContext, Fragment, ComponentProps, type ReactElement } from "react";
import ReactMarkdownBase from "react-markdown";
import { rehypeSearchHighlight } from "../../lib/rehypeSearchHighlight";
import { parseSearchTerms } from "@codecast/shared/search";
import { splitMarkdownBlocks } from "../../lib/markdownBlocks";
import { RevealHost } from "../ObjectReveal";
import { tryRenderHtmlMessage } from "../HtmlSnippet";
import { parseInsightBlocks } from "../insightBlocks";
import { CollapsibleImage, ImageRowParagraph } from "../tools/MarkdownRenderer";
import { EntityAwareCode, EntityAwareLink } from "../EntityIdPill";
import { entityRemarkPlugins } from "../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE, MESSAGE_MD_COMPONENTS, USER_MD_REMARK, renderMarkdownPre } from "../messageMarkdown";
import { HighlightContext } from "../HighlightContext";

function extractTextFromHast(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(extractTextFromHast).join('');
  return '';
}

type ReactMarkdownProps = ComponentProps<typeof ReactMarkdownBase>;

/**
 * ReactMarkdown wrapper that appends `rehypeSearchHighlight` to the plugin list
 * whenever a `highlightQuery` is active in the HighlightContext. Because the plugin
 * transforms the HAST before React renders, highlights are part of the VDOM and
 * survive re-renders — avoiding the MutationObserver/TreeWalker race we used before.
 *
 * memo: react-markdown re-runs its full parse pipeline on every render, so a
 * parent re-render (streaming tick, heartbeat) must bail out here whenever the
 * props are unchanged. Only works when call sites pass module-stable plugin
 * arrays and component maps — never inline literals. Context updates (search
 * query) bypass memo, so highlights still repaint.
 */
export const ReactMarkdown = memo(function ReactMarkdown(props: ReactMarkdownProps) {
  const query = useContext(HighlightContext);
  const userPlugins = props.rehypePlugins;
  const plugins = useMemo(() => {
    const base = userPlugins ? [...userPlugins] : [];
    if (!query) return base;
    const terms = parseSearchTerms(query);
    if (terms.length === 0) return base;
    base.push([rehypeSearchHighlight, { terms }]);
    return base;
  }, [query, userPlugins]);
  return <ReactMarkdownBase {...props} rehypePlugins={plugins} />;
});

// Stable variants for non-message-body call sites (tool results, sent-message
// cards, command markdown, summaries). Same identity rule as above: the memo'd
// ReactMarkdown wrapper only bails out of a re-parse when these are module consts.
export const MD_COMPONENTS_CODE_LINK = { code: MESSAGE_MD_COMPONENTS.code, a: MESSAGE_MD_COMPONENTS.a };
// "No images" must be enforced, not implied: with no `img` override react-markdown
// emits a raw <img>, which auto-fetches — full-bleed layout AND the third-party
// beacon channel CollapsibleImage's click gate exists to close.
export const MD_COMPONENTS_NO_IMG = { ...MD_COMPONENTS_CODE_LINK, pre: MESSAGE_MD_COMPONENTS.pre, img: () => null };
export const MD_COMPONENTS_NO_PRE = { ...MD_COMPONENTS_CODE_LINK, img: MESSAGE_MD_COMPONENTS.img };


// Cross-mount markdown render cache. React.memo only helps while a component
// stays MOUNTED — but the message virtualizer constantly unmounts and remounts
// rows (conversation switch, bottom-anchor correction walk, scroll-back), and
// each remount re-ran the full remark/rehype parse: 70-300ms per block for
// table/code-dense messages, ~350 block mounts in one switch = multi-second
// main-thread freeze (ct-36614). react-markdown's default export is a plain
// hook-free function (parse → hast → toJsxRuntime), so its element output is
// pure data keyed entirely by content — cache it module-wide and a remount
// costs only element instantiation. Map insertion order doubles as LRU.
const MD_RENDER_CACHE = new Map<string, ReactElement>();
const MD_RENDER_CACHE_MAX = 500;

// Above this size an assistant body is parsed per block (split at blank lines
// outside code fences) with each block cached separately. A streaming message
// grows at its END, so every prefix block hits the cache and only the last
// block reparses per push — without this, each streaming push reparsed the
// whole growing body (70-300ms for giant code/table bodies). Only giant
// bodies take this path: splitting can change loose-list grouping
// cosmetically, so ordinary messages keep exact single-parse semantics.
const MD_BLOCK_SPLIT_THRESHOLD = 8000;

function mdCachePut(key: string, el: ReactElement): ReactElement {
  MD_RENDER_CACHE.set(key, el);
  if (MD_RENDER_CACHE.size > MD_RENDER_CACHE_MAX) {
    MD_RENDER_CACHE.delete(MD_RENDER_CACHE.keys().next().value!);
  }
  return el;
}

function renderMessageMarkdownCached(content: string, userText?: boolean): ReactElement {
  const key = userText ? "\u0000u" + content : content;
  const hit = MD_RENDER_CACHE.get(key);
  if (hit) {
    MD_RENDER_CACHE.delete(key);
    MD_RENDER_CACHE.set(key, hit);
    return hit;
  }
  if (!userText && content.length > MD_BLOCK_SPLIT_THRESHOLD) {
    const blocks = splitMarkdownBlocks(content);
    // Recurse only when the split made progress: a body with no blank lines
    // outside fences returns itself as one block, and recursing on the
    // identical string overflows the stack (the cache write happens after
    // the recursive calls, so it can't break the loop).
    if (blocks.length > 1) {
      const el = (
        <>
          {blocks.map((b, i) => (
            <Fragment key={i}>{renderMessageMarkdownCached(b)}</Fragment>
          ))}
        </>
      );
      return mdCachePut(key, el);
    }
  }
  const el = ReactMarkdownBase({
    children: content,
    remarkPlugins: userText ? USER_MD_REMARK : entityRemarkPlugins,
    rehypePlugins: MESSAGE_MD_REHYPE,
    components: MESSAGE_MD_COMPONENTS,
  });
  return mdCachePut(key, el);
}

// Memoized message-body renderer. With no active search, render through the
// cross-mount cache above. An active search query changes the rendered output
// (rehypeSearchHighlight), so that rare path bypasses the cache and goes
// through the context-aware ReactMarkdown wrapper instead.
// Above this size a pasted user body renders as plain text: the remark parse
// costs 70-300ms on giant pastes (logs, stack traces) and markdown semantics
// add nothing to them — pre-wrap even keeps their line breaks exact where
// markdown would collapse them. Assistant bodies keep markdown at any size.
const USER_PLAIN_TEXT_THRESHOLD = 4000;

export const MessageMarkdown = memo(function MessageMarkdown({ content, userText }: { content: string; userText?: boolean }) {
  const query = useContext(HighlightContext);
  // An all-HTML body renders as a sanitized canvas — the markdown pipeline
  // escapes raw tags into garbled source.
  const html = tryRenderHtmlMessage(content);
  if (html) return html;
  if (userText && !query && content.length > USER_PLAIN_TEXT_THRESHOLD) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }
  // RevealHost: any object reference in the body (pill or card) can open its
  // full page inline, as a full-bleed band after the body's blocks. It renders
  // a fragment, so the blocks stay direct children of the message content.
  if (query) {
    return (
      <RevealHost persistKey={content}>
        <ReactMarkdown remarkPlugins={userText ? USER_MD_REMARK : entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE} components={MESSAGE_MD_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </RevealHost>
    );
  }
  return <RevealHost persistKey={content}>{renderMessageMarkdownCached(content, userText)}</RevealHost>;
});

// Renders an assistant message body as a flat run of block elements: ★ Insight
// fences become InsightCards, everything else is markdown, emitted as a FRAGMENT
// (no wrapper) so each block stays a DIRECT child of MessageReview's .cc-content
// and remains independently hover-quotable — a wrapper div would collapse the
// whole message into one un-quotable block. Module-level const so MessageReview's
// memo holds (a fresh inline arrow at the call site would defeat it).
export const renderAssistantBody = (content: string) => {
  const parts = parseInsightBlocks(content);
  if (!parts.some((p) => p.type === "insight")) return <MessageMarkdown content={content} />;
  return (
    <>
      {parts.map((part, i) =>
        part.type === "insight" ? (
          <InsightCard key={i} label={part.label} content={part.content} />
        ) : (
          <MessageMarkdown key={i} content={part.content} />
        ),
      )}
    </>
  );
};

export function hasRichMarkdown(text: string): boolean {
  if (/\b(ct|pl)-[a-z0-9]+\b/i.test(text)) return true;
  const markers = [
    /^#{1,3}\s+\S/m,           // headers
    /\|.+\|.+\|/,              // tables
    /^```\w*/m,                 // fenced code blocks
    /^\d+\.\s+\*\*[^*]+\*\*/m, // numbered list with bold
    /^-\s+\[[ x]\]/im,         // task lists
  ];
  let hits = 0;
  for (const m of markers) {
    if (m.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

export const CMD_MD_COMPONENTS = {
  code: EntityAwareCode,
  a: EntityAwareLink,
  img: ({ src, alt }: { src?: string; alt?: string }) => <CollapsibleImage src={src} alt={alt} />,
  p: ImageRowParagraph,
  pre: ({ node, children, ...props }: any) => renderMarkdownPre(node, children, props),
};

function InsightCard({ label, content }: { label: string; content: string }) {
  return (
    <div className="my-3 rounded-lg overflow-hidden border border-sol-violet/30 bg-gradient-to-br from-sol-bg-alt via-sol-bg-alt to-sol-violet/5">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-violet/20 bg-sol-violet/8">
        <svg className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z" />
        </svg>
        <span className="text-xs font-semibold tracking-wide uppercase text-sol-violet">{label}</span>
      </div>
      <div className="px-4 py-3 text-sm text-sol-text-secondary leading-relaxed prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={entityRemarkPlugins} rehypePlugins={MESSAGE_MD_REHYPE}
          components={MD_COMPONENTS_NO_IMG}
        >{content}</ReactMarkdown>
      </div>
    </div>
  );
}

export function linkifyMentions(text: string, map: Record<string, string>): string {
  if (!text || Object.keys(map).length === 0) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/@([\w][\w-]*)/g, (match, name) => {
      const childId = map[name];
      if (childId) return `[@${name}](/conversation/${childId})`;
      return match;
    });
  }).join('');
}
