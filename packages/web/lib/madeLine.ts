// What a hosted receipt's made thing reads as, for the web transcript
// (components/conversation/HostedMadeLine) and the phone's (components/
// hosted/Steps): the step's words and the thing's name, a note's opening for
// its card, and a routine's state now. Pure, so both clients read one rule.

/** How much of a note the card shows: its first lines, or a table's head. */
const PREVIEW_LINES = 3;
const PREVIEW_ROWS = 4;

export type NotePreview = { kind: "lines"; lines: string[] } | { kind: "table"; rows: string[][] } | null;

/** The opening of a note's markdown for its card: the first table's header
 *  and rows when the note leads with one, else its first lines as plain text
 *  (a heading that repeats the title is skipped). */
export function notePreview(content: string | undefined | null, title?: string): NotePreview {
  const lines = (content ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const plainTitle = (title ?? "").trim().toLowerCase();
  const body = lines.filter((line, i) => !(i === 0 && /^#+\s/.test(line) && line.replace(/^#+\s*/, "").trim().toLowerCase() === plainTitle));
  const first = body.findIndex((l) => !/^#+\s/.test(l));
  if (first < 0) return null;
  if (body[first].startsWith("|")) {
    const rows: string[][] = [];
    for (const line of body.slice(first)) {
      if (!line.startsWith("|")) break;
      if (/^\|?[\s:|-]+\|?$/.test(line)) continue;
      rows.push(line.replace(/^\||\|$/g, "").split("|").map((cell) => plainInline(cell.trim())));
      if (rows.length >= PREVIEW_ROWS) break;
    }
    return rows.length ? { kind: "table", rows } : null;
  }
  return { kind: "lines", lines: body.slice(first, first + PREVIEW_LINES).map((l) => plainInline(l.replace(/^#+\s*/, "").replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, "").replace(/^\d+\.\s+/, ""))) };
}

/** The columns whose body cells are all figures (a quantity, a price), which
 *  the card keeps tight so the text columns get the width. */
export function numericColumns(rows: string[][]): Set<number> {
  const body = rows.slice(1);
  const out = new Set<number>();
  if (body.length === 0) return out;
  const width = Math.max(...rows.map((r) => r.length));
  for (let j = 0; j < width; j++) {
    if (body.every((r) => /^[\s\d.,%$€£×x+~-]*\d[\s\d.,%$€£×x+~-]*$/i.test(r[j] ?? ""))) out.add(j);
  }
  return out;
}

/** Markdown's inline marks dropped, for a muted preview. */
function plainInline(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** The step's words and the quoted name at their end ("Set up the routine"
 *  and "Morning stretch"), or null when the words do not end on one (the
 *  line then keeps the folded receipt). The name stands in for the thing
 *  while its row resolves, and for good once the row is gone. */
export function madeLineParts(summary: string): { words: string; name: string } | null {
  const m = summary.match(/^(.*\S)\s+["“]([^"”]+)["”]$/);
  return m ? { words: m[1], name: m[2] } : null;
}

/** What a routine's row says about it now, when that is not "on". */
export function routineState(status: string | undefined, entity: { schedule_type?: string; run_count?: number } | null): string | null {
  if (status === "paused") return "Paused";
  if (status === "cancelled") return "Deleted";
  if (status === "completed") return entity?.schedule_type === "once" && (entity.run_count ?? 0) > 0 ? "Done" : "Stopped";
  return null;
}
