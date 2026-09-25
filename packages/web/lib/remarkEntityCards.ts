import { parseEntityUrl, CONTEXTUAL_PR_REF_PREFIX, entityTypeFromId, type EntityType } from "./entityLinks";

const CARD_PREFIX = "card:";

export type EntityCardsOptions = {
  /** Only these types are promoted; every other reference stays a pill. A
   *  conversation transcript promotes a staffing proposal alone (an agent's
   *  `op-N` on its own line draws the proposal live, org-staffing.md S24) and
   *  keeps a lone task id the inline pill it always was; team chat, where a
   *  bare reference is someone sharing the object, promotes them all. */
  types?: readonly EntityType[];
};

/** Payloads that never become cards: date pills, doc transclusions, and a
 *  pull request named by number alone (`pr:#N|…`), which only the surrounding
 *  conversation can complete to an object and so stays an inline pill. With
 *  `types`, only a reference of one of those types. */
function cardEligible(payload: string, types?: readonly EntityType[]): boolean {
  if (/^date:/i.test(payload) || payload.startsWith("embed:") || payload.startsWith(CONTEXTUAL_PR_REF_PREFIX)) return false;
  if (!types) return true;
  const type = payload.startsWith("doc:") ? "doc" : entityTypeFromId(payload);
  return !!type && types.includes(type);
}

/** Set on a link that named a pull request or commit by URL: the reference
 *  is beyond doubt, so the card path keeps it a reference even when codecast
 *  holds no row for it (see EntityIdPill `certain`). */
export const REF_CERTAIN_ATTR = "data-ref-certain";

function mdastText(node: any): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (Array.isArray(node.children)) return node.children.map(mdastText).join("");
  return "";
}

function isEntityLink(node: any, types?: readonly EntityType[]): boolean {
  return (
    node?.type === "link" &&
    typeof node.url === "string" &&
    node.url.startsWith("entity://") &&
    // A mention ("@jx7abcd", lib/remarkChatMentions) addresses the object; it
    // is not the author sharing it, so it stays an inline pill.
    !node.data?.hProperties?.["data-mention"] &&
    cardEligible(mdastText(node), types)
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
      if (ref.type === "pr" || ref.type === "commit") {
        child.data = { ...child.data, hProperties: { ...child.data?.hProperties, [REF_CERTAIN_ATTR]: "1" } };
      }
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
function paragraphLinks(node: any, types?: readonly EntityType[]): any[] | null {
  if (node?.type !== "paragraph" || !Array.isArray(node.children)) return null;
  const links: any[] = [];
  for (const child of node.children) {
    if (isEntityLink(child, types)) links.push(child);
    else if (!isIgnorable(child)) return null;
  }
  return links.length > 0 ? links : null;
}

/** The entity links of a list whose every item is references-only, else null. */
function listLinks(node: any, types?: readonly EntityType[]): any[] | null {
  if (node?.type !== "list" || !Array.isArray(node.children) || node.children.length === 0) return null;
  const links: any[] = [];
  for (const item of node.children) {
    if (item?.type !== "listItem" || !Array.isArray(item.children)) return null;
    const blocks = item.children.filter((c: any) => !isIgnorable(c));
    if (blocks.length !== 1) return null;
    const itemLinks = paragraphLinks(blocks[0], types);
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

function splitInline(node: any, types?: readonly EntityType[]): any[] {
  if (isEntityLink(node, types) || !["strong", "emphasis", "delete"].includes(node.type)) return [node];
  const parts: any[] = [];
  let children: any[] = [];
  const flush = () => {
    if (children.length) parts.push({ ...node, children });
    children = [];
  };
  for (const child of node.children.flatMap((c: any) => splitInline(c, types))) {
    if (isEntityLink(child, types)) {
      flush();
      parts.push(child);
    } else children.push(child);
  }
  flush();
  return parts;
}

function paragraphBlocks(node: any, types?: readonly EntityType[]): any[] | null {
  if (node.type !== "paragraph" || !Array.isArray(node.children)) return null;
  const children = node.children.flatMap((c: any) => splitInline(c, types));
  if (!children.some((c: any) => isEntityLink(c, types))) return null;
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
    if (isEntityLink(child, types)) {
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

function walk(node: any, types?: readonly EntityType[]) {
  if (!Array.isArray(node?.children)) return;
  node.children = node.children.flatMap((child: any) => {
    const list = listLinks(child, types);
    if (list) return [toCardRow(list)];
    const blocks = paragraphBlocks(child, types);
    if (blocks) return blocks;
    walk(child, types);
    return [child];
  });
}

export function remarkEntityCards(options?: EntityCardsOptions) {
  const types = options?.types;
  return (tree: any) => {
    normalizeEntityLinks(tree);
    walk(tree, types);
  };
}
