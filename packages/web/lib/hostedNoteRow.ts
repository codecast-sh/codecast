// How hosted mode names a note in a list (plan pl-840): the title over a line
// of what it says, as a reader would list notes. Shared by the web's DocRow
// and the phone's DocItemRow so the two read one rule.
import { stripMarkdown } from "@codecast/shared/contracts/plainText";

/** A note's first words after its title, as one line. */
export function noteSnippet(content: string | undefined, title: string): string {
  const text = stripMarkdown((content ?? "").slice(0, 600)).replace(/\s+/g, " ").trim();
  const body = text.startsWith(title) ? text.slice(title.length).trim() : text;
  return body.slice(0, 160);
}

/** The row's two lines. An untitled note goes by its first sentence, as a
 *  conversation goes by its ask, so two untitled notes can be told apart
 *  without opening them; the line under it is what follows. */
export function hostedNoteLines(doc: { title?: string | null; display_title?: string | null; content?: string }): { title: string; snippet: string } {
  const title = doc.display_title || doc.title || "Untitled";
  const named = !!(doc.display_title || doc.title?.trim()) && title !== "Untitled";
  if (named) return { title, snippet: noteSnippet(doc.content, title) };
  const opening = noteSnippet(doc.content, "");
  const shown = opening.split(/(?<=[.!?])\s/)[0].slice(0, 80) || title;
  return { title: shown, snippet: opening.slice(shown.length).trim() };
}
