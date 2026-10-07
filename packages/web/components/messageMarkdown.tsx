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
import { remarkEntityCards, type EntityCardsOptions } from "../lib/remarkEntityCards";
import { MarkdownImg, ImageRowParagraph } from "./tools/MarkdownImages";
import { EntityAwareCode, EntityAwareLink } from "./EntityIdPill";
import { MarkdownReplyQuote } from "./ReplyQuote";
import { renderPre } from "../lib/fenceRenderers";

export function renderMarkdownPre(node: any, children: any, props: any) {
  return renderPre(node, children, props);
}

// Stable plugin/component identities for message-body markdown. Inline literals at
// the call sites made react-markdown re-run its full parse + rehype-highlight pass on
// EVERY block re-render — measured as the single largest cost during a session switch
// (~4.2s self-time / 775 renders). None of these overrides close over props.
export const MESSAGE_MD_REHYPE = [rehypeHighlight];
export const MESSAGE_MD_COMPONENTS = {
  code: EntityAwareCode,
  a: EntityAwareLink,
  img: MarkdownImg,
  p: ImageRowParagraph,
  pre: ({ node, children, ...props }: any) => renderMarkdownPre(node, children, props),
};
// A user's blockquote is a quote they replied to (the quote tool writes one).
export const USER_MD_COMPONENTS = { ...MESSAGE_MD_COMPONENTS, blockquote: MarkdownReplyQuote };

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
// An agent's body: entity pills, and a staffing proposal alone on its line
// drawn live as a card (org-staffing.md S24: the head of people posts a small
// proposal and writes its `op-N` on its own line), and so is a call: `cl-42`
// alone on its line is the call's card, `cl-42:15-25` the words said in those
// turns, embedded, and a replay likewise: `rp-12` alone is its card,
// `rp-12@1:23` the recorded page playing from that second. Only those types are promoted here, so a lone task id in a
// transcript keeps the inline pill it always had; team chat (ChatMessage)
// promotes every shared reference to a card. Alone on its line only: the same
// reference mid-sentence is a citation and keeps its pill.
const ASSISTANT_CARDS: EntityCardsOptions = { types: ["proposal", "call", "replay"], aloneOnly: true };
export const ASSISTANT_MD_REMARK = [...entityRemarkPlugins, [remarkEntityCards, ASSISTANT_CARDS] as [typeof remarkEntityCards, EntityCardsOptions]];
