// Sharing an object is a different act from mentioning one. "Fixed the race
// in ct-4102" is prose — the reference stays an inline pill. But a message
// whose line is NOTHING BUT references ("jx7c6zk", or a list of three task
// ids) is someone handing objects to the room, and it earns a richer default:
// a preview card per object, browsable in place.
//
// This plugin runs AFTER remarkEntityIds, which has already turned every id
// into an entity:// link whose TEXT node carries the payload (react-markdown's
// url sanitizer strips custom protocols, so the text is the real carrier —
// see remarkEntityIds). It finds paragraphs made only of such links, and lists
// whose every item is one, and:
//
//   • rewrites each link's text payload to `card:<count>:<payload>` so
//     EntityAwareLink renders an EntityObjectCard instead of a pill, and
//   • re-tags the containing paragraph (or the whole list) as a block-level
//     <div class="entity-card-row">, the grid the cards lay out in.
//
// The count rides in each payload so a card knows whether it stands alone
// (full-width, richer preview) or shares the row with siblings (compact).
// Opt-in per surface: only chat registers it today — a conversation transcript
// keeps its tighter pill rendering.

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

function walk(node: any, inListItem = false) {
  if (!Array.isArray(node?.children)) return;
  node.children = node.children.map((child: any) => {
    // Inside a list item, never promote: a MIXED list (some items prose, some
    // bare ids) reads as one list, and turning half its items into cards while
    // the rest stay bullets would shred it. A list that is references
    // throughout is caught whole by listLinks below, before recursion.
    if (!inListItem) {
      const para = paragraphLinks(child);
      if (para) return toCardRow(para);
      const list = listLinks(child);
      if (list) return toCardRow(list);
    }
    walk(child, inListItem || child.type === "listItem");
    return child;
  });
}

export function remarkEntityCards() {
  return (tree: any) => walk(tree);
}
