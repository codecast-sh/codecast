// Whether a message reads as structured markdown (headers, tables, fences,
// bold numbered lists, task lists, or a task or plan id) rather than plain
// prose. Pure, so the message classifier can use it without loading the
// markdown renderers; the phone's bundle reaches the classifier.
export function hasRichMarkdown(text: string): boolean {
  if (/\b(ct|pl)-[a-z0-9]+\b/i.test(text)) return true;
  const markers = [
    /^#{1,3}\s+\S/m,           // headers
    /\|.+\|.+\|/,              // tables
    /^```\w*/m,                 // fenced code blocks
    /^\d+\.\s+\*\*[^*]+\*\*/m, // numbered list with bold
    /^-\s+\[[ x]\]/im,         // task lists
  ];
  let hits = 0;
  for (const m of markers) {
    if (m.test(text)) hits++;
    if (hits >= 2) return true;
  }
  return false;
}
