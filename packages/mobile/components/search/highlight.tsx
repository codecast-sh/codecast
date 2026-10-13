// Marking the words a search found, on the phone. The terms are the ones the
// server ranked by (parseQueryTerms, shared with web's highlightMatch), so a
// hit is marked the same on both. Plain text marks through HighlightText; the
// markdown renderer marks its own text runs when a query is provided here
// (SearchHighlightContext), so a matched message shows its hits inside the
// rendered message, pills and emphasis intact.
import { Children, cloneElement, createContext, isValidElement, type ReactNode } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { parseQueryTerms, termSpans } from '@codecast/shared/search';
import { Text as RNText } from '@/components/Themed';
import { Theme } from '@/constants/Theme';

/** The active search's words (operators stripped), for text rendered under it. */
export const SearchHighlightContext = createContext<string | undefined>(undefined);

const markStyle = (): TextStyle => ({ backgroundColor: Theme.yellow + '55', color: Theme.text });

/** `text` as runs, the found words marked; the bare string when nothing matched. */
export function markedRuns(text: string, query: string | undefined, keyPrefix = 'h'): ReactNode {
  if (!query?.trim() || !text) return text;
  const spans = termSpans(text, parseQueryTerms(query));
  if (spans.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  spans.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<RNText key={`${keyPrefix}${i}`} style={markStyle()}>{text.slice(start, end)}</RNText>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** One line of plain text with the found words marked (a title, a name). */
export function HighlightText({ text, query, style, numberOfLines }: { text: string; query?: string; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  return <RNText style={style} numberOfLines={numberOfLines}>{markedRuns(text, query)}</RNText>;
}

/** Inline markdown nodes with the found words marked in every text run. A
 *  node that is not text (a pill, a link) passes through untouched. */
export function markInlineNodes(nodes: ReactNode[], query: string): ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === 'string') return markedRuns(node, query, `s${i}-`);
    if (!isValidElement<{ children?: ReactNode }>(node) || node.type !== RNText) return node;
    const kids = Children.toArray(node.props.children);
    if (!kids.some((k) => typeof k === 'string')) return node;
    return cloneElement(node, undefined, ...kids.map((k, j) => (typeof k === 'string' ? markedRuns(k, query, `n${i}-${j}-`) : k)));
  });
}
