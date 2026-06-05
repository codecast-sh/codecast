import { findAndReplace } from "mdast-util-find-and-replace";
import remarkGfm from "remark-gfm";
import type { Options as ReactMarkdownOptions } from "react-markdown";

const ENTITY_ID_RE = /\b(?:(?:ct|pl)-[a-z0-9]+|jx[a-z0-9]{5,})\b/gi;
const MENTION_RE = /@\[([^\]]*?)(?:\s+(ct-\w+|pl-\w+|jx\w+|doc:\w+))?\](?:\s*\([^)]*\))?/g;

export function remarkEntityIds() {
  return (tree: any) => {
    findAndReplace(tree, [
      [
        MENTION_RE,
        (_match: string, name: string, entityId?: string) => {
          if (entityId && (/^(ct|pl)-/.test(entityId) || /^jx[a-z0-9]/i.test(entityId))) {
            return {
              type: "link",
              url: `entity://${entityId.toLowerCase()}`,
              children: [{ type: "text", value: entityId.toLowerCase() }],
            };
          }
          if (entityId && entityId.startsWith("doc:")) {
            return {
              type: "link",
              url: `mention://${name.trim()}`,
              children: [{ type: "text", value: `@${name.trim()}` }],
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
        (match: string) => ({
          type: "link",
          url: `entity://${match.toLowerCase()}`,
          children: [{ type: "text", value: match.toLowerCase() }],
        }),
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
