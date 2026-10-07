// A hosted receipt whose one step made one thing ("Set up the routine
// Morning stretch"), as one line: the step's words with the thing's live name
// as the link, and the thing's state now when it has changed since (a routine
// paused or stopped later). Replaces the folded receipt plus a separate pill,
// which named the same thing twice and opened to nothing more.
//
// A note is the exception: what the person asked for often IS the note (a
// packing list, a weekend plan), so it shows as a quiet card with its title
// and its opening lines, one tap from the whole thing.
import Link from "next/link";
import { useEntityResolution } from "../../lib/entityDisplay";
import { useInboxStore } from "../../store/inboxStore";

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

/** Markdown's inline marks dropped, for a muted preview. */
function plainInline(text: string): string {
  return text.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

/** The note a turn wrote, as a card under the receipt: the step's words, the
 *  note's title in the reading face, its opening in muted ink with a fade,
 *  and "Open note". Paints from the cached body first (docDetails), then the
 *  live row. */
export function HostedNoteCard({ words, refId }: { words?: string | null; refId: string }) {
  const r = useEntityResolution(refId);
  const docId = refId.replace(/^doc:/i, "");
  const cached = useInboxStore((s) => (s.docDetails as Record<string, { content?: string } | undefined>)[docId]?.content);
  const preview = notePreview(cached ?? r.entity?.content, r.fullLabel);
  return (
    <Link href={r.href} className="not-prose block my-3 no-underline" data-cc-made-note={refId}>
      {words && <span className="block mb-1.5 text-[12.5px] text-sol-text-dim" data-cc-made-note-words>{words.replace(/[:\s]+$/, "")}</span>}
      <span className="block rounded-[10px] border px-4 pt-3 pb-2.5" data-cc-made-note-card>
        <span className="block truncate" data-cc-made-note-title>{r.fullLabel}</span>
        {preview && (
          <span className="block mt-1.5 overflow-hidden" data-cc-made-note-body>
            {preview.kind === "lines"
              ? preview.lines.map((line, i) => <span key={i} className="block truncate">{line}</span>)
              : (
                <table>
                  <tbody>
                    {preview.rows.map((row, i) => (
                      <tr key={i} data-head={i === 0 || undefined}>
                        {row.map((cell, j) => <td key={j}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </span>
        )}
        <span className="block mt-2" data-cc-made-note-open>Open note</span>
      </span>
    </Link>
  );
}

/** The step's words without the quoted name at their end, or null when the
 *  words do not end on one (the line then keeps the folded receipt). */
export function wordsBeforeName(summary: string): string | null {
  const m = summary.match(/^(.*\S)\s+["“][^"”]+["”]$/);
  return m ? m[1] : null;
}

/** What a routine's row says about it now, when that is not "on". */
function routineState(status: string | undefined, entity: { schedule_type?: string; run_count?: number } | null): string | null {
  if (status === "paused") return "Paused";
  if (status === "cancelled") return "Deleted";
  if (status === "completed") return entity?.schedule_type === "once" && (entity.run_count ?? 0) > 0 ? "Done" : "Stopped";
  return null;
}

export function HostedMadeLine({ words, refId }: { words: string; refId: string }) {
  if (/^doc:/i.test(refId)) return <HostedNoteCard words={words} refId={refId} />;
  return <HostedMadeRef words={words} refId={refId} />;
}

function HostedMadeRef({ words, refId }: { words: string; refId: string }) {
  const r = useEntityResolution(refId);
  const state = r.type === "trigger" ? routineState(r.status, r.entity) : null;
  return (
    <p className="not-prose mt-2 mb-2 text-[12.5px] leading-snug text-sol-text-dim" data-cc-made-line={refId}>
      {words}{" "}
      <Link href={r.href} data-cc-inline-link className="text-sol-text no-underline hover:underline underline-offset-2">{r.fullLabel}</Link>
      {state && <span data-cc-made-state>{` · ${state}`}</span>}
    </p>
  );
}
