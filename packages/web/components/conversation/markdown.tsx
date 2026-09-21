import { useMemo, memo, useContext, Fragment, ComponentProps, type ReactElement } from "react";
import ReactMarkdownBase from "react-markdown";
import { rehypeSearchHighlight } from "../../lib/rehypeSearchHighlight";
import { parseSearchTerms } from "@codecast/shared/search";
import { splitMarkdownBlocks } from "../../lib/markdownBlocks";
import { RevealHost } from "../ObjectReveal";
import { tryRenderHtmlMessage } from "../HtmlSnippet";
import { entityRemarkPlugins } from "../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE, MESSAGE_MD_COMPONENTS, USER_MD_REMARK } from "../messageMarkdown";
import { HighlightContext } from "../HighlightContext";
import { MD_COMPONENTS_NO_IMG } from "../../lib/conversationMarkdown";

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

export function InsightCard({ label, content }: { label: string; content: string }) {
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
