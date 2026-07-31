// Remark plugin for Obsidian wiki links in the vault reading view.
//
// `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]`, `[[Target#^block]]`
// become link nodes with a `wiki://` URL carrying the raw inner text;
// `![[Target]]` embeds use `wikiembed://` and get block-hoisted the same way
// remarkEntityIds hoists doc embeds. Unlike the entity pipeline, the vault
// renderer passes a custom urlTransform that PRESERVES these schemes, so the
// href is the payload carrier and the children stay pure display text.
//
// findAndReplace only visits prose text nodes, so code fences and inline code
// are naturally excluded; existing links are skipped via `ignore`.

import { findAndReplace } from "mdast-util-find-and-replace";
import remarkGfm from "remark-gfm";
import type { Options as ReactMarkdownOptions } from "react-markdown";

// Inner text: no brackets or pipes in target; alias may contain anything but
// closing brackets. An odd leading "!" marks an embed. Escaped \[[ is skipped
// by requiring the char before the match not be a backslash (handled in the
// replacer via the third arg's index — findAndReplace gives (match, ...groups)).
const WIKI_RE = /(!?)\[\[([^\[\]|#]+)?(#[^\[\]|]+)?(?:\|([^\[\]]+))?\]\]/g;

export interface WikiLinkParts {
  target: string;      // "" = same-file (e.g. [[#Heading]])
  subpath?: string;    // heading text or block id, without the leading #/^
  subpathType?: "heading" | "block";
  alias?: string;
  isEmbed: boolean;
}

export function parseWikiInner(raw: string): WikiLinkParts | null {
  const m = raw.match(/^(!?)\[\[([^\[\]|#]+)?(#[^\[\]|]+)?(?:\|([^\[\]]+))?\]\]$/);
  if (!m) return null;
  const [, bang, target, hash, alias] = m;
  if (!target && !hash) return null;
  const parts: WikiLinkParts = { target: (target ?? "").trim(), isEmbed: bang === "!" };
  if (hash) {
    const sub = hash.slice(1);
    if (sub.startsWith("^")) {
      parts.subpath = sub.slice(1).trim();
      parts.subpathType = "block";
    } else {
      parts.subpath = sub.trim();
      parts.subpathType = "heading";
    }
  }
  if (alias !== undefined) parts.alias = alias.trim();
  return parts;
}

export const WIKI_SCHEME = "wiki://";
export const WIKI_EMBED_SCHEME = "wikiembed://";

export function wikiHref(raw: string, isEmbed: boolean): string {
  return `${isEmbed ? WIKI_EMBED_SCHEME : WIKI_SCHEME}${encodeURIComponent(raw)}`;
}

/** Reverse of wikiHref: the raw `[[...]]`/`![[...]]` source text. */
export function wikiRawFromHref(href: string): string | null {
  if (href.startsWith(WIKI_SCHEME)) return decodeURIComponent(href.slice(WIKI_SCHEME.length));
  if (href.startsWith(WIKI_EMBED_SCHEME)) return decodeURIComponent(href.slice(WIKI_EMBED_SCHEME.length));
  return null;
}

export function wikiDisplayText(parts: WikiLinkParts): string {
  if (parts.alias) return parts.alias;
  if (!parts.target) return parts.subpath ?? "";
  if (parts.subpath && parts.subpathType === "heading") return `${parts.target} › ${parts.subpath}`;
  return parts.target;
}

function isWikiEmbedNode(node: any): boolean {
  return node?.type === "link" && typeof node.url === "string" && node.url.startsWith(WIKI_EMBED_SCHEME);
}

/** A paragraph that is exactly one embed renders the embed at block level; an
 *  embed mixed into prose is DEMOTED to an ordinary wiki link (its url scheme
 *  rewritten) — a block-level transclusion card inside a <p> is invalid HTML.
 *  Same semantics as remarkEntityIds.hoistEmbeds. */
function hoistWikiEmbeds(node: any) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child: any) => {
    if (child.type === "paragraph" && Array.isArray(child.children)) {
      const meaningful = child.children.filter(
        (c: any) => !(c.type === "text" && !c.value?.trim()),
      );
      if (meaningful.length === 1 && isWikiEmbedNode(meaningful[0])) return meaningful[0];
      child.children = child.children.map((c: any) =>
        isWikiEmbedNode(c)
          ? { ...c, url: WIKI_SCHEME + c.url.slice(WIKI_EMBED_SCHEME.length) }
          : c,
      );
      return child;
    }
    hoistWikiEmbeds(child);
    return child;
  });
}

export function remarkWikiLink() {
  return (tree: any) => {
    findAndReplace(
      tree,
      [
        [
          WIKI_RE,
          (match: string) => {
            const parts = parseWikiInner(match);
            if (!parts) return false;
            return {
              type: "link",
              url: wikiHref(match, parts.isEmbed),
              children: [{ type: "text", value: wikiDisplayText(parts) }],
            };
          },
        ],
      ],
      { ignore: ["link"] },
    );
    hoistWikiEmbeds(tree);
  };
}

/** Remark chain for vault note bodies: GFM (house tilde setting) + wiki links. */
export const vaultRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  remarkWikiLink,
];
