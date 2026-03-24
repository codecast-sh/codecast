import { findAndReplace } from "mdast-util-find-and-replace";

const ENTITY_ID_RE = /\b(ct|pl)-[a-z0-9]+\b/gi;
const MENTION_RE = /@\[([^\]]*?)(?:\s+(ct-\w+|pl-\w+|jx\w+))?\](?:\s*\([^)]*\))?/g;

export function remarkEntityIds() {
  return (tree: any) => {
    findAndReplace(tree, [
      [
        MENTION_RE,
        (_match: string, name: string, entityId?: string) => {
          if (entityId && /^(ct|pl)-/.test(entityId)) {
            return {
              type: "link",
              url: `entity://${entityId.toLowerCase()}`,
              children: [{ type: "text", value: entityId.toLowerCase() }],
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
    ]);
  };
}
