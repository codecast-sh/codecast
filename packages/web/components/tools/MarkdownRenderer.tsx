import ReactMarkdown, { type Components } from "react-markdown";
import { memo } from "react";
import { tryRenderHtmlMessage } from "../HtmlSnippet";
import { MD_COMPONENTS } from "../../lib/markdownComponents";
import { MD_REHYPE_PLUGINS, MD_REMARK_PLUGINS } from "../../lib/markdownPlugins";

export { CollapsibleImage, ImageRowParagraph } from "./MarkdownImages";

interface MarkdownRendererProps {
  content: string;
  filePath?: string;
  className?: string;
}

// memo: props are all primitives (content/filePath/className), so this skips the
// expensive markdown parse + syntax-highlight whenever the content value is
// unchanged — even if the parent message block re-renders.
// The markdown body WITHOUT the wrapping prose div, so each parsed block (h1, p,
// ul, …) is a direct sibling element. Callers that need to measure or annotate
// individual blocks (e.g. the quote/comment review rail) render this so the
// blocks become direct children of their own container; everyone else uses
// MarkdownRenderer, which wraps these in the prose container.
export const MarkdownBlocks = memo(function MarkdownBlocks({
  content,
  components = MD_COMPONENTS,
}: {
  content: string;
  /** Component-map override for surfaces with their own type scale (the doc
   *  reading view). Must be a module-level constant — a fresh object identity
   *  per render defeats both this memo and react-markdown's caching. */
  components?: Components;
}) {
  // An all-HTML body renders as a sanitized canvas — the markdown pipeline
  // escapes raw tags into garbled source.
  const html = tryRenderHtmlMessage(content);
  if (html) return html;
  return (
    <ReactMarkdown
      remarkPlugins={MD_REMARK_PLUGINS}
      rehypePlugins={MD_REHYPE_PLUGINS}
      components={components}
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
