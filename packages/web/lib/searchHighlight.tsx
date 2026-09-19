// Drawing a search hit: one place decides what counts as a term, what a
// snippet around it looks like, and how a match is marked. The header search,
// the /search page and chat search all render from these, so a hit looks the
// same wherever it is shown.
import { parseSearchTerms } from "@codecast/shared/search";

export { parseSearchTerms };

export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;

  const terms = parseSearchTerms(query);
  if (terms.length === 0) return text;

  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  if (parts.length === 1) return text;

  return (
    <>
      {parts.map((part, i) => {
        const isMatch = terms.some((t) => part.toLowerCase() === t);
        return isMatch ? (
          <mark
            key={i}
            className="bg-amber-300/40 text-amber-900 dark:text-amber-200 rounded px-0.5 font-medium"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

export function getSnippet(content: string, query: string, maxLen = 400): string {
  const lowerContent = content.toLowerCase();
  const terms = parseSearchTerms(query);

  let bestIndex = -1;
  for (const term of terms) {
    const idx = lowerContent.indexOf(term);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
      bestIndex = idx;
    }
  }

  if (bestIndex === -1) return content.slice(0, maxLen);

  // Keep the hit in view with a quarter of the budget of lead-in before it.
  const lead = Math.round(maxLen / 4);
  const start = Math.max(0, bestIndex - lead);
  const end = Math.min(content.length, bestIndex + (maxLen - lead));
  let snippet = content.slice(start, end);

  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";

  return snippet;
}
