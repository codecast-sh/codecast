// The text in an assistant's answer that the person asked for to send or use
// (a note, a reply, a message), which the hosted prompt sets apart as a
// quote. A Copy button under the answer copies this, not the words around it.

/** The first quoted passage in `markdown`, without its quote marks, or null
 *  when the answer quotes nothing. Blank quote lines inside it are kept as
 *  paragraph breaks. */
export function sendableText(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const lines: string[] = [];
  let inQuote = false;
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fence = !fence;
    const quote = !fence && line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      inQuote = true;
      lines.push(quote[1]);
    } else if (inQuote) break;
  }
  const text = lines.join("\n").trim();
  return text || null;
}
