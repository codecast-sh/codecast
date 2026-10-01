import { CLOSE_TAG, parseOpenTag } from "@codecast/shared/docs";

// Drafting markup (@codecast/shared/docs drafting) in read-only markdown.
// Without rehype-raw, react-markdown prints a raw <span> as literal text, so a
// doc with alternatives or ghosts would read as tag soup in review mode, on a
// share page or in an embed. Here each drafting span becomes what the reader
// should see: alternatives and Lab flags read as the text showing now, and a
// ghost keeps its words but dims them, as in the editor.
//
// markdown-it and mdast both split inline HTML into an opening and a closing
// `html` node with the content as siblings between them, so the pairing is a
// walk over each children list counting <span> depth.

const OPEN_SPAN = /^<span\b[^>]*>$/;

function transformChildren(children: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type === "html" && OPEN_SPAN.test(node.value.trim())) {
      const parsed = parseOpenTag(node.value.trim());
      if (parsed) {
        let depth = 1;
        let j = i + 1;
        for (; j < children.length; j++) {
          const n = children[j];
          if (n.type !== "html") continue;
          const v = n.value.trim();
          if (OPEN_SPAN.test(v)) depth++;
          else if (v === CLOSE_TAG && --depth === 0) break;
        }
        const inner = transformChildren(children.slice(i + 1, j));
        if (parsed.kind === "ghost") {
          out.push({
            type: "emphasis",
            children: inner,
            data: { hName: "span", hProperties: { className: ["md-draft-ghost"] } },
          });
        } else {
          out.push(...inner);
        }
        i = j;
        continue;
      }
    }
    if (Array.isArray(node.children)) node.children = transformChildren(node.children);
    out.push(node);
  }
  return out;
}

export function remarkDrafting() {
  return (tree: any) => {
    if (Array.isArray(tree.children)) tree.children = transformChildren(tree.children);
  };
}
