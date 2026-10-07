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
import { notePreview, numericColumns, routineState } from "../../lib/madeLine";
export { madeLineParts, notePreview, numericColumns, type NotePreview } from "../../lib/madeLine";

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
                <NoteTable rows={preview.rows} />
              )}
          </span>
        )}
        <span className="block mt-2" data-cc-made-note-open>Open note</span>
      </span>
    </Link>
  );
}

/** A note's leading table, as the card previews it: figures held tight,
 *  text columns sharing the rest (globals.css [data-cc-made-note-body]). */
function NoteTable({ rows }: { rows: string[][] }) {
  const numeric = numericColumns(rows);
  return (
    <table>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} data-head={i === 0 || undefined}>
            {row.map((cell, j) => <td key={j} data-num={numeric.has(j) || undefined}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function HostedMadeLine({ words, name, refId }: { words: string; name?: string; refId: string }) {
  if (/^doc:/i.test(refId)) return <HostedNoteCard words={words} refId={refId} />;
  return <HostedMadeRef words={words} name={name} refId={refId} />;
}

function HostedMadeRef({ words, name, refId }: { words: string; name?: string; refId: string }) {
  const r = useEntityResolution(refId);
  // The server answered with no row: the thing was deleted since (a routine
  // removed on Routines). Its name from the step, as plain text, never the
  // machine id the resolver falls back to.
  const gone = r.served && !r.entity && !!name;
  const state = gone ? "Deleted" : r.type === "trigger" ? routineState(r.status, r.entity) : null;
  const label = r.entity ? r.fullLabel : name ?? r.fullLabel;
  return (
    <p className="not-prose mt-2 mb-2 text-[12.5px] leading-snug text-sol-text-dim" data-cc-made-line={refId}>
      {words}{" "}
      {gone
        ? <span className="text-sol-text" data-cc-made-name>{label}</span>
        : <Link href={r.href} data-cc-inline-link className="text-sol-text no-underline hover:underline underline-offset-2">{label}</Link>}
      {state && <span data-cc-made-state>{` · ${state}`}</span>}
    </p>
  );
}
