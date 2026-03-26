import { findAndReplace } from "mdast-util-find-and-replace";

const ENTITY_ID_RE = /\b(ct|pl)-[a-z0-9]+\b/gi;
const SESSION_ID_RE = /\bjx[a-z0-9]{5}\b/g;
const MENTION_RE = /@\[([^\]]*?)(?:\s+(ct-\w+|pl-\w+|jx\w+|@[\w.-]+))?\](?:\s*\([^)]*\))?/g;

export function remarkEntityIds() {
  return (tree: any) => {
    findAndReplace(tree, [
      [
        MENTION_RE,
        (_match: string, name: string, entityId?: string) => {
          if (entityId && (/^(ct|pl)-/.test(entityId) || /^jx[a-z0-9]{5}$/i.test(entityId))) {
            return {
              type: "link",
              url: `entity://${entityId.toLowerCase()}`,
              children: [{ type: "text", value: entityId.toLowerCase() }],
            };
          }
          if (entityId && /^@[\w.-]+$/.test(entityId)) {
            const handle = entityId.slice(1);
            return {
              type: "link",
              url: `user://${handle}`,
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
      [
        SESSION_ID_RE,
        (match: string) => ({
          type: "link",
          url: `entity://${match.toLowerCase()}`,
          children: [{ type: "text", value: match.toLowerCase() }],
        }),
      ],
    ]);
  };
}
