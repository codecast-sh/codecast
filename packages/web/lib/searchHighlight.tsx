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

/** Machine wrappers a message can carry (a session message, a reminder, a
 *  command tag): a tag-shaped name, lower case, its attributes, or the cut
 *  tail of one at either edge of a stored snippet. */
const WRAPPER_TAG = /<\/?[a-z][a-z0-9]*(?:[-:_][a-z0-9]+)+(?:\s[^<>]*)?>|^[a-z0-9-]*(?:\s[a-z_]+="[^"]*")+\s*>|<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?$/g;

/** A snippet as text a person reads: machine wrappers (`<session-message>`,
 *  `<system-reminder>`) go, the words inside them stay. */
export function stripSnippetMarkup(text: string): string {
  return text.replace(WRAPPER_TAG, " ").replace(/\s{2,}/g, " ").trim();
}

/** The stretch of `content` that shows the most of the query (snippetAround),
 *  without the machine wrappers around injected messages. */
export function getSnippet(content: string, query: string, maxLen = 400): string {
  return snippetAround(stripSnippetMarkup(content), parseQueryTerms(query), maxLen);
}
