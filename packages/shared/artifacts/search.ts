// The words a person wrote in an artifact, as one text the search index holds:
// sticky and text bodies, titles and names, cell input (formulas left out),
// a story's headline, summary and narration. Pure, so the server indexes the
// same text any client would.
import type { ArtifactElement } from "./core";

/** Fields that hold a person's words, in any product. */
const WORD_FIELDS = ["text", "title", "name", "label", "input", "headline", "summary", "say", "say_title"] as const;

/** Characters of text one artifact indexes. */
export const SEARCH_TEXT_MAX = 32_000;

export function artifactSearchText(title: string, elements: readonly ArtifactElement[]): string {
  const parts: string[] = [title];
  let size = title.length;
  for (const el of elements) {
    for (const f of WORD_FIELDS) {
      const v = (el as Record<string, unknown>)[f];
      if (typeof v !== "string") continue;
      const s = v.trim();
      // A formula is code, not words; a lone character is noise.
      if (s.length < 2 || (f === "input" && s.startsWith("="))) continue;
      parts.push(s);
      size += s.length + 1;
      if (size >= SEARCH_TEXT_MAX) return parts.join("\n").slice(0, SEARCH_TEXT_MAX);
    }
  }
  return parts.join("\n");
}

/** The stretch of `text` around the first word of `query` it holds, for a result line. */
export function searchSnippet(text: string, query: string, width = 80): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    at = lower.indexOf(w);
    if (at >= 0) break;
  }
  // A result line reads as words: markdown marks (emphasis, headings, quotes, links' brackets, code ticks) go.
  const line = (s: string) => s.replace(/[*_#>`~]+|\[|\]\([^)]*\)|\]/g, "").replace(/\s+/g, " ").trim();
  if (at < 0) return line(text.slice(0, width));
  const start = Math.max(0, at - Math.floor(width / 3));
  return `${start > 0 ? "…" : ""}${line(text.slice(start, start + width))}${start + width < text.length ? "…" : ""}`;
}
