// A comment's anchor on a published page: the JSON the in-page bar stores in
// artifact_comments.anchor. Every field is optional, old anchors carry only
// {x, y, snippet}, and nothing may depend on one being present.
//   x, y     the point, as fractions of the document's width and height
//   snippet  the words the comment was made on
//   sel      a stable path to the element under the point (an id, a
//            data-cast-id, or nth-of-type steps from <body>)
//   ox, oy   the point inside that element's box, as fractions
//   t        seconds into the page's timeline (window.__castTimeline)
export interface PageAnchor {
  x?: number;
  y?: number;
  snippet?: string;
  sel?: string;
  ox?: number;
  oy?: number;
  t?: number;
}

export function parsePageAnchor(raw: string | null | undefined): PageAnchor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PageAnchor) : null;
  } catch {
    return null;
  }
}

// "0:14", "1:02:05": a timeline position the way the page shows it.
export function formatTimelineAt(t: number): string {
  const s = Math.max(0, Math.round(t));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

// Where a comment points, in words: the element, the moment of the timeline,
// and the words it was made on. Empty when the anchor names none of them.
export function describePageAnchor(a: PageAnchor | null): string[] {
  if (!a) return [];
  const parts: string[] = [];
  if (typeof a.sel === "string" && a.sel) parts.push(`on element \`${a.sel.slice(0, 160)}\``);
  if (typeof a.t === "number" && Number.isFinite(a.t)) parts.push(`at ${formatTimelineAt(a.t)} of the timeline`);
  if (a.snippet) parts.push(`on the words "${String(a.snippet).slice(0, 120)}"`);
  return parts;
}
