// Wrap every occurrence of a needle in the text nodes under a root with a
// <mark>, and undo it. DOM-based on purpose: the callers search HTML that is
// already rendered (a vault note, a syntax-highlighted code block), where the
// live nodes are the only faithful view of what the reader sees.
//
// Case-insensitive and literal (not regex) — a find that silently reads `.`
// as "any character" is a trap.

export type MarkOptions = {
  className: string;
  /** Extra attributes stamped on every mark (e.g. a data-* hook for activation). */
  attrs?: Record<string, string>;
};

export function markMatches(root: Node, needles: string[], opts: MarkOptions): HTMLElement[] {
  const lowers = needles.map((n) => n.toLowerCase()).filter((n) => n.length > 0);
  if (lowers.length === 0) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const value = node.nodeValue?.toLowerCase();
      if (!value || !lowers.some((n) => value.includes(n))) return NodeFilter.FILTER_REJECT;
      // A text node straight under a fragment has no parent element; only a
      // node already inside a mark is skipped.
      if (node.parentElement?.closest(`.${cssEscape(opts.className)}`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) targets.push(n as Text);

  const marks: HTMLElement[] = [];
  for (const text of targets) {
    const value = text.nodeValue ?? "";
    const lower = value.toLowerCase();
    const frag = doc.createDocumentFragment();
    let cursor = 0;
    for (;;) {
      const hit = earliestHit(lower, lowers, cursor);
      if (!hit) break;
      if (hit.index > cursor) frag.appendChild(doc.createTextNode(value.slice(cursor, hit.index)));
      const mark = doc.createElement("mark");
      mark.className = opts.className;
      for (const [k, v] of Object.entries(opts.attrs ?? {})) mark.setAttribute(k, v);
      mark.textContent = value.slice(hit.index, hit.index + hit.length);
      frag.appendChild(mark);
      marks.push(mark);
      cursor = hit.index + hit.length;
    }
    if (marks.length === 0 || cursor === 0) continue;
    if (cursor < value.length) frag.appendChild(doc.createTextNode(value.slice(cursor)));
    text.parentNode?.replaceChild(frag, text);
  }
  return marks;
}

/** Undo markMatches: unwrap the marks and re-join the split text nodes so a
 *  later search sees whole words again. */
export function clearMarks(root: ParentNode, className: string) {
  const doc = (root as Node).ownerDocument ?? (root as Document);
  const marks = [...root.querySelectorAll(`.${cssEscape(className)}`)];
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(doc.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize();
  }
}

/** Mark matches inside an HTML string (a syntax-highlighted code block) and
 *  hand back the marked HTML. Pure in effect: nothing on the page is touched. */
export function markMatchesInHtml(html: string, needles: string[], opts: MarkOptions): string {
  if (typeof document === "undefined") return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  if (markMatches(tpl.content, needles, opts).length === 0) return html;
  return tpl.innerHTML;
}

function earliestHit(lower: string, needles: string[], from: number): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const needle of needles) {
    const idx = lower.indexOf(needle, from);
    if (idx === -1) continue;
    if (!best || idx < best.index || (idx === best.index && needle.length > best.length)) best = { index: idx, length: needle.length };
  }
  return best;
}

// A class name with a dot or a slash (tailwind's `bg-amber-300/50`) needs
// escaping inside a selector; CSS.escape is absent in some test DOMs.
function cssEscape(s: string): string {
  return s.replace(/([^\w-])/g, "\\$1");
}
