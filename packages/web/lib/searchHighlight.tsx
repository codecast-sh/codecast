// Drawing a search hit: one place decides what counts as a term, what a
// snippet around it looks like, and how a match is marked. The header search,
// the /search page and chat search all render from these, so a hit looks the
// same wherever it is shown.
import { parseSearchTerms, parseQueryTerms, termSpans, snippetAround } from "@codecast/shared/search";

export { parseSearchTerms };

/** `text` with the words the search used marked. The terms are the ones the
 *  server ranked by (parseQueryTerms): a stop-word or a lone letter it dropped
 *  is not marked, and neighbouring words found together are one mark. */
export function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const spans = termSpans(text, parseQueryTerms(query));
  if (spans.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach(([start, end], i) => {
    if (start > at) parts.push(<span key={`t${i}`}>{text.slice(at, start)}</span>);
    parts.push(
      <mark
        key={`m${i}`}
        className="bg-amber-300/40 text-amber-900 dark:text-amber-200 rounded px-0.5 font-medium"
      >
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(<span key="tail">{text.slice(at)}</span>);
  return <>{parts}</>;
}

/** The stretch of `content` that shows the most of the query (snippetAround). */
export function getSnippet(content: string, query: string, maxLen = 400): string {
  return snippetAround(content, parseQueryTerms(query), maxLen);
}
