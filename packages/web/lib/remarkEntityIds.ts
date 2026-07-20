import { findAndReplace } from "mdast-util-find-and-replace";
import remarkGfm from "remark-gfm";
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { isConvexId } from "./entityLinks";

// The bare 32-char alternative catches full Convex ids — the only handle docs
// have (no short id). EntityIdPill resolves their table server-side; ids that
// resolve to nothing render back as plain text.
const ENTITY_ID_RE = /\b(?:(?:ct|pl)-[a-z0-9]+|jx[a-z0-9]{5,}|doc:[a-z0-9]{20,}|[a-z0-9]{32})\b/gi;
const MENTION_RE = /@\[([^\]]*?)(?:\s+(ct-\w+|pl-\w+|jx\w+|doc:\w+|[a-z0-9]{32}))?\](?:\s*\([^)]*\))?/g;

export function remarkEntityIds() {
  return (tree: any) => {
    findAndReplace(tree, [
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
