import { parseEntityUrl } from "./entityLinks";

const CARD_PREFIX = "card:";

/** Payloads that never become cards: date pills and doc transclusions. */
function cardEligible(payload: string): boolean {
  return !/^date:/i.test(payload) && !payload.startsWith("embed:");
}

function mdastText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (Array.isArray(node.children)) return node.children.map(mdastText).join("");
  return "";
}

function isEntityLink(node: any): boolean {
  return (
    node?.type === "link" &&
    typeof node.url === "string" &&
    node.url.startsWith("entity://") &&
    cardEligible(mdastText(node))
  );
}

function normalizeEntityLinks(node: any) {
  if (!Array.isArray(node?.children)) return;
  for (const child of node.children) {
    if (child.type === "link") {
      const ref = parseEntityUrl(child.url);
      if (!ref) continue;
      const payload = ref.type === "doc" ? `doc:${ref.id}` : ref.id;
      child.url = `entity://${payload}`;
      child.children = [{ type: "text", value: payload }];
    } else {
      normalizeEntityLinks(child);
    }
  }
}

/** Whitespace and hard breaks — the glue between shared ids, not content. */
function isIgnorable(node: any): boolean {
  return (node.type === "text" && !node.value?.trim()) || node.type === "break";
}

/** The entity links of a references-only paragraph, or null if it has prose. */
function paragraphLinks(node: any): any[] | null {
  if (node?.type !== "paragraph" || !Array.isArray(node.children)) return null;
  const links: any[] = [];
  for (const child of node.children) {
    if (isEntityLink(child)) links.push(child);
    else if (!isIgnorable(child)) return null;
  }
  return links.length > 0 ? links : null;
}

/** The entity links of a list whose every item is references-only, else null. */
function listLinks(node: any): any[] | null {
  if (node?.type !== "list" || !Array.isArray(node.children) || node.children.length === 0) return null;
  const links: any[] = [];
  for (const item of node.children) {
    if (item?.type !== "listItem" || !Array.isArray(item.children)) return null;
    const blocks = item.children.filter((c: any) => !isIgnorable(c));
    if (blocks.length !== 1) return null;
    const itemLinks = paragraphLinks(blocks[0]);
    if (!itemLinks) return null;
    links.push(...itemLinks);
  }
  return links;
}

function toCardRow(links: any[]): any {
  for (const link of links) {
    const payload = mdastText(link);
    link.children = [{ type: "text", value: `${CARD_PREFIX}${links.length}:${payload}` }];
    // The marker class is the authenticity check: EntityAwareLink renders a
    // card only when BOTH the payload and this class are present. Without it,
    // a hand-typed `[card:1:ct-…](url)` in a doc or task description — a
    // surface that never registered this plugin — would render a card into a
    // <p>, which is both a surprise and invalid HTML (cards are divs; only
    // this plugin re-tags the containing paragraph as a div).
    link.data = { ...link.data, hProperties: { ...link.data?.hProperties, className: "entity-card-ref" } };
  }
  return {
    type: "paragraph",
    children: links,
    data: {
      hName: "div",
      hProperties: { className: "entity-card-row", "data-card-count": String(links.length) },
    },
  };
}

function splitInline(node: any): any[] {
  if (isEntityLink(node) || !["strong", "emphasis", "delete"].includes(node.type)) return [node];
  const parts: any[] = [];
  let children: any[] = [];
  const flush = () => {
    if (children.length) parts.push({ ...node, children });
    children = [];
  };
  for (const child of node.children.flatMap(splitInline)) {
    if (isEntityLink(child)) {
      flush();
      parts.push(child);
    } else children.push(child);
  }
  flush();
  return parts;
}

function paragraphBlocks(node: any): any[] | null {
  if (node.type !== "paragraph" || !Array.isArray(node.children)) return null;
  const children = node.children.flatMap(splitInline);
  if (!children.some(isEntityLink)) return null;
  const blocks: any[] = [];
  let prose: any[] = [];
  let links: any[] = [];
  const flushProse = () => {
    while (prose.length && isIgnorable(prose[0])) prose.shift();
    while (prose.length && isIgnorable(prose.at(-1))) prose.pop();
    if (prose.length) blocks.push({ ...node, children: prose });
    prose = [];
  };
  const flushLinks = () => {
    if (links.length) blocks.push(toCardRow(links));
    links = [];
  };
  for (const child of children) {
    if (isEntityLink(child)) {
      flushProse();
      links.push(child);
    } else if (links.length && isIgnorable(child)) {
      continue;
    } else {
      flushLinks();
      prose.push(child);
    }
  }
  flushLinks();
  flushProse();
  return blocks;
}

function walk(node: any) {
  if (!Array.isArray(node?.children)) return;
  node.children = node.children.flatMap((child: any) => {
    const list = listLinks(child);
    if (list) return [toCardRow(list)];
    const blocks = paragraphBlocks(child);
    if (blocks) return blocks;
    walk(child);
    return [child];
  });
}

export function remarkEntityCards() {
  return (tree: any) => {
    normalizeEntityLinks(tree);
    walk(tree);
  };
}
