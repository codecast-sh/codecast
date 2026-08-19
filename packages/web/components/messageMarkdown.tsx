"use client";

// The message-body markdown pipeline: stable plugin/component identities that
// ConversationView and chat/ChatMessage both render with. Its exports are data
// (arrays, objects) rather than components, so an edit here re-executes its two
// importers — that is why they live in this small module and NOT in
// ConversationView.tsx: a non-component export there turned every save of the
// 3k-line view into a failed Fast Refresh boundary that re-executed all twelve
// of its importers.

import rehypeHighlight from "rehype-highlight";
import remarkBreaks from "remark-breaks";
import { entityRemarkPlugins } from "../lib/remarkEntityIds";
import { CollapsibleImage, ImageRowParagraph } from "./tools/MarkdownRenderer";
import { EntityAwareCode, EntityAwareLink } from "./EntityIdPill";
import { CodeBlock } from "./CodeBlock";
import { tryRenderCastDiff } from "./InlineDiff";
import { tryRenderCanvas } from "./HtmlSnippet";

function extractTextFromHast(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(extractTextFromHast).join('');
  return '';
}

export function renderMarkdownPre(node: any, children: any, props: any) {
  const codeElement = node?.children?.[0];
  if (codeElement && codeElement.type === "element" && codeElement.tagName === "code") {
    const className = codeElement.properties?.className as string[] | undefined;
    const language = className?.find((cls) => cls.startsWith("language-"))?.replace("language-", "");
    const code = extractTextFromHast(codeElement);
    if (code) {
      const canvas = tryRenderCanvas(language, code);
      if (canvas) return canvas;
      const castDiff = tryRenderCastDiff(language, code);
      if (castDiff) return castDiff;
      return <CodeBlock code={code} language={language} />;
    }
  }
  return <pre {...(props as any)}>{children as any}</pre>;
}

// Stable plugin/component identities for message-body markdown. Inline literals at
// the call sites made react-markdown re-run its full parse + rehype-highlight pass on
// EVERY block re-render — measured as the single largest cost during a session switch
// (~4.2s self-time / 775 renders). None of these overrides close over props.
export const MESSAGE_MD_REHYPE = [rehypeHighlight];
export const MESSAGE_MD_COMPONENTS = {
  code: EntityAwareCode,
  a: EntityAwareLink,
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => <CollapsibleImage src={src} alt={alt} />,
  p: ImageRowParagraph,
  pre: ({ node, children, ...props }: any) => renderMarkdownPre(node, children, props),
};

// User messages are typed (or pasted) as plain text, not authored markdown: a
// single newline is a real line break, and a literal <tag> is content, not
// markup. remark-breaks keeps the newlines; the html→text pass keeps pasted
// tags visible (react-markdown drops raw html nodes, which would otherwise
// silently eat snippets like `<div className=…>` from the rendered message).
function remarkUserHtmlAsText() {
  const walk = (node: any, isRoot: boolean) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.map((child: any) => {
      if (child.type === "html") {
        const text = { type: "text", value: child.value };
        // A block-level html node sits directly under root, where a bare text
        // node isn't valid flow content — rewrap it as a paragraph.
        return isRoot ? { type: "paragraph", children: [text] } : text;
      }
      walk(child, false);
      return child;
    });
  };
  return (tree: any) => walk(tree, true);
}
export const USER_MD_REMARK = [...entityRemarkPlugins, remarkBreaks, remarkUserHtmlAsText];
