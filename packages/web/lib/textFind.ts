// Find in rendered text without touching the DOM: matches become Ranges and
// paint through the CSS Custom Highlight API (`::highlight(name)` in CSS), so
// a React tree that keeps re-rendering under the highlights (a live call's
// words, a streaming transcript) never has its text nodes split or wrapped.

/** Every case-insensitive occurrence of `query` in the text under `root`.
 *  `accept` narrows which text nodes count (skip labels, clocks, previews). */
export function findTextRanges(root: Node, query: string, accept?: (node: Text) => boolean): Range[] {
  if (!query) return [];
  const ranges: Range[] = [];
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (accept && !accept(node)) continue;
    const text = node.data.toLowerCase();
    let at = text.indexOf(needle);
    while (at !== -1) {
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

function registry(): Map<string, unknown> | null {
  return typeof CSS !== "undefined" && "highlights" in CSS ? ((CSS as any).highlights as Map<string, unknown>) : null;
}

/** Paint `ranges` under the highlight `name`; none clears it. A browser
 *  without the API finds and steps all the same, it just paints nothing. */
export function setHighlight(name: string, ranges: Range[]): void {
  const reg = registry();
  if (!reg) return;
  if (ranges.length === 0) reg.delete(name);
  else reg.set(name, new (window as any).Highlight(...ranges));
}
