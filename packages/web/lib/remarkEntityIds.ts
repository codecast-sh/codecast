import { findAndReplace } from "mdast-util-find-and-replace";

const ENTITY_ID_RE = /\b(ct|pl)-[a-z0-9]+\b/gi;

export function remarkEntityIds() {
  return (tree: any) => {
    findAndReplace(tree, [
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
