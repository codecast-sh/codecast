// Drawing a search hit: one place decides what counts as a term, what a
// snippet around it looks like, and how a match is marked. The header search,
// the /search page and chat search all render from these, so a hit looks the
// same wherever it is shown.
import { parseSearchTerms, parseQueryTerms, termSpans, snippetAround, stripWrapperTags } from "@codecast/shared/search";

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
      // The conversation's own hit style (globals.css mark.search-hit), so a
      // word found reads the same in a title, a snippet and the transcript.
      <mark key={`m${i}`} className="search-hit">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(<span key="tail">{text.slice(at)}</span>);
  return <>{parts}</>;
}

/** A snippet as one line a person reads: machine wrappers out (the shared
 *  stripWrapperTags), whitespace folded. */
export function stripSnippetMarkup(text: string): string {
  return stripWrapperTags(text).replace(/\s{2,}/g, " ").trim();
}

/** The stretch of `content` that shows the most of the query (snippetAround),
 *  without the machine wrappers around injected messages. */
export function getSnippet(content: string, query: string, maxLen = 400): string {
  return snippetAround(stripSnippetMarkup(content), parseQueryTerms(query), maxLen);
}
