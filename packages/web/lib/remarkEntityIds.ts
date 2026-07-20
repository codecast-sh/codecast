import { findAndReplace } from "mdast-util-find-and-replace";
import remarkGfm from "remark-gfm";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { isConvexId } from "./entityLinks";

// The bare 32-char alternative catches full Convex ids — the only handle docs
// have (no short id). EntityIdPill resolves their table server-side; ids that
// resolve to nothing render back as plain text.
const ENTITY_ID_RE = /\b(?:(?:ct|pl)-[a-z0-9]+|jx[a-z0-9]{5,}|doc:[a-z0-9]{20,}|[a-z0-9]{32})\b/gi;
const MENTION_RE = /@\[([^\]]*?)(?:\s+(ct-\w+|pl-\w+|jx\w+|doc:\w+|[a-z0-9]{32}))?\](?:\s*\([^)]*\))?/g;
// Obsidian-style transclusion: ![[doc:<convex id>]]. Only docs are embeddable —
// they're the entity whose body IS markdown meant to be read in place.
const EMBED_RE = /!\[\[(doc:[a-z0-9]{32})\]\]/g;

function isEmbedLink(node: any): boolean {
  return node?.type === "link" && typeof node.url === "string" && node.url.startsWith("embed://");
}

/**
 * Post-pass over the tree after findAndReplace: a paragraph consisting solely
 * of one embed link gets REPLACED by that link, so the embed renders at block
 * level (a full doc card inside a <p> is invalid HTML and reads wrong). An
 * embed mixed into surrounding prose is demoted to an ordinary doc pill —
 * transclusion is a block-level act, same semantics as Obsidian.
 */
function hoistEmbeds(node: any) {
  if (!Array.isArray(node.children)) return;
  node.children = node.children.map((child: any) => {
    if (child.type === "paragraph" && Array.isArray(child.children)) {
      const meaningful = child.children.filter(
        (c: any) => !(c.type === "text" && !c.value?.trim()),
      );
      if (meaningful.length === 1 && isEmbedLink(meaningful[0])) return meaningful[0];
      child.children = child.children.map((c: any) =>
        isEmbedLink(c)
          ? {
              ...c,
              url: c.url.replace("embed://", "entity://"),
              children: [{ type: "text", value: c.url.slice("embed://".length) }],
            }
          : c,
      );
      return child;
    }
    hoistEmbeds(child);
    return child;
  });
}

export function remarkEntityIds() {
  return (tree: any) => {
    findAndReplace(tree, [
      [
        EMBED_RE,
        (_match: string, docRef: string) => ({
          type: "link",
          url: `embed://${docRef}`,
          // react-markdown's url sanitizer drops the embed:// href, so — as
          // with entity:// below — the text node is the real payload carrier.
          children: [{ type: "text", value: `embed:${docRef}` }],
        }),
      ],
      [
        MENTION_RE,
        (_match: string, name: string, entityId?: string) => {
          if (entityId && (/^(ct|pl)-/.test(entityId) || /^jx[a-z0-9]/i.test(entityId) || isConvexId(entityId))) {
            return {
              type: "link",
              url: `entity://${entityId.toLowerCase()}`,
              children: [{ type: "text", value: entityId.toLowerCase() }],
            };
          }
          if (entityId && entityId.startsWith("doc:")) {
            // Docs have no short id, so the doc's convex id rides in the link
            // *text* — react-markdown drops the `entity://` href via its url
            // sanitizer, so the text node is the real carrier. EntityAwareLink
            // reads "doc:<id>" and renders a doc pill, same path as ct-/jx ids.
            return {
              type: "link",
              url: `entity://${entityId}`,
              children: [{ type: "text", value: entityId }],
            };
          }
          return {
            type: "link",
            url: `mention://${name.trim()}`,
            children: [{ type: "text", value: `@${name.trim()}` }],
          };
        },
      ],
      [
        ENTITY_ID_RE,
        (match: string) => {
          // The bare-32-char alternative matched case-insensitively, but real
          // Convex ids are all-lowercase — leave an uppercase hash lookalike
          // as plain text rather than lowercasing (= altering) displayed text.
          if (/^[a-z0-9]{32}$/i.test(match) && !isConvexId(match)) return false;
          return {
            type: "link",
            url: `entity://${match.toLowerCase()}`,
            children: [{ type: "text", value: match.toLowerCase() }],
          };
        },
      ],
    ], { ignore: ['link'] });
    hoistEmbeds(tree);
  };
}

/**
 * The remark plugin chain shared by every markdown surface in the app
 * (conversation prose, shared-message pages, comments, the activity digest,
 * tool views, and the generic file renderer).
 *
 * `singleTilde: false` is the important bit: remark-gfm defaults to treating a
 * lone "~" as a strikethrough delimiter, which is looser than GitHub itself.
 * Agents routinely use "~" as an "approximately" sign ("~$5/mo", "~5 items"),
 * so two of them on one line would otherwise pair up and strike through
 * everything between them. With this off, lone tildes render literally while
 * intentional "~~strikethrough~~" (double tilde) still works.
 */
export const entityRemarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  remarkEntityIds,
];
