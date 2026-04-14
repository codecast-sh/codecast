import type { Root, Element, Text, RootContent, ElementContent } from "hast";

type Options = {
  terms: string[];
  className?: string;
};

/**
 * Rehype plugin that wraps occurrences of any search term (case-insensitive)
 * in `<mark data-search-highlight="true">` nodes within the HAST tree. Because
 * the wrapping happens in the tree React-markdown converts to React elements,
 * highlights survive re-renders — unlike DOM-level surgery via MutationObserver.
 */
export function rehypeSearchHighlight(options: Options) {
  const terms = (options.terms ?? []).filter(t => t.length > 0);
  if (terms.length === 0) return () => undefined;

  const pattern = terms
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const className =
    options.className ??
    "bg-amber-300/50 text-amber-900 dark:bg-amber-700/40 dark:text-amber-100 rounded px-0.5 font-medium";

  const shouldSkip = (node: Element): boolean => {
    const tag = node.tagName;
    if (tag === "code" || tag === "pre" || tag === "script" || tag === "style" || tag === "mark") return true;
    return false;
  };

  const splitTextNode = (text: Text): (Text | Element)[] => {
    const value = text.value;
    if (!value) return [text];
    regex.lastIndex = 0;
    const out: (Text | Element)[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    let found = false;
    while ((m = regex.exec(value)) !== null) {
      found = true;
      if (m.index > lastIndex) {
        out.push({ type: "text", value: value.slice(lastIndex, m.index) });
      }
      out.push({
        type: "element",
        tagName: "mark",
        properties: {
          "data-search-highlight": "true",
          className,
        },
        children: [{ type: "text", value: m[0] }],
      });
      lastIndex = m.index + m[0].length;
    }
    if (!found) return [text];
    if (lastIndex < value.length) {
      out.push({ type: "text", value: value.slice(lastIndex) });
    }
    return out;
  };

  const visit = (node: Root | Element): void => {
    if (!node.children) return;
    const next: (Element | Text | RootContent)[] = [];
    for (const child of node.children) {
      if (child.type === "text") {
        const parts = splitTextNode(child);
        next.push(...parts);
      } else {
        if (child.type === "element") {
          if (!shouldSkip(child)) visit(child);
        }
        next.push(child);
      }
    }
    node.children = next as ElementContent[];
  };

  return (tree: Root) => {
    visit(tree);
  };
}
