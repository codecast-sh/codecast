// The notes a sent message pinned on its own pictures, read back from its
// text. A send writes each note as a quote naming the picture and its marker
// (lib/quoteFormat imageQuoteText), followed by the note itself:
//
//   > [Image 2] at marker 3 (26% from the left, 40% from the top)
//   > Image returned by your Read call ...
//
//   the note
//
// The picture carries the marker drawn on it (lib/markedImage), and the
// transcript reads these back to show each note when its marker is hovered.
// Messages sent before the point was written name only the marker: their
// notes come back without a point.

export type ImageNote = { number: number; body: string; point?: { x: number; y: number } };

const MARKER_LINE = /^>\s?\[Image (\d+)\] at marker (\d+)(?: \((\d+(?:\.\d+)?)% from the left, (\d+(?:\.\d+)?)% from the top\))?\s*$/;

/** Each picture's notes, keyed by its [Image N] number (1-based). */
export function parseImageNotes(content: string): Map<number, ImageNote[]> {
  const out = new Map<number, ImageNote[]>();
  if (!content.includes("at marker")) return out;
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = MARKER_LINE.exec(lines[i]);
    if (!m) { i++; continue; }
    i++;
    // The rest of the quote: where the picture came from.
    while (i < lines.length && lines[i].startsWith(">")) i++;
    // The note runs to the next quote. After the batch's last quote comes the
    // person's own reply, one blank line down, so a note with no quote after
    // it ends at its first blank line.
    const start = i;
    while (i < lines.length && !lines[i].startsWith(">")) i++;
    let body = lines.slice(start, i);
    if (i >= lines.length) {
      const text = body.join("\n").trim();
      const cut = text.search(/\n\s*\n/);
      body = [cut < 0 ? text : text.slice(0, cut)];
    }
    const note: ImageNote = { number: Number(m[2]), body: body.join("\n").trim() };
    if (m[3] !== undefined && m[4] !== undefined) note.point = { x: Number(m[3]) / 100, y: Number(m[4]) / 100 };
    const image = Number(m[1]);
    out.set(image, [...(out.get(image) ?? []), note]);
  }
  return out;
}

type MessageWithImages = { content?: string; images?: readonly { storage_id?: string; tool_use_id?: string }[] };

/** The notes on one picture of a message, found by its stored file. */
export function messageImageNotes(message: MessageWithImages | undefined, storageId: string | undefined): ImageNote[] {
  if (!message?.content || !storageId) return [];
  const attached = (message.images ?? []).filter((img) => !img.tool_use_id);
  const k = attached.findIndex((img) => img.storage_id === storageId);
  return k < 0 ? [] : parseImageNotes(message.content).get(k + 1) ?? [];
}
