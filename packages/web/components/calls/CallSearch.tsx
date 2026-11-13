// Search the calls list: what a call is called, who was in it, its recap,
// and every word said in it. The first three are matched here from the list
// the page already holds, so they answer on the keystroke; the words come
// from the server's search over spoken lines (transcripts.webSearchCalls),
// which searches only the calls the viewer may read. A call found by its
// words shows the lines that matched, each a link to that moment.

import { memo, useMemo } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { callAnchorHref, callPathRef } from "@codecast/shared/contracts";
import { formatCallTime } from "@codecast/shared/entities";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useDebounce } from "../../hooks/useDebounce";
import { useInboxStore } from "../../store/inboxStore";
import { callTitle, type CallPlace } from "../../lib/calls/roomLabels";
import { firstName, speakerColor } from "./speakers";
import "./callSearch.css";

type Line = { seq: number; speaker_id: string; speaker_name: string; text: string; t0: number };

export type CallSearchResult = {
  call: any;
  /** Spoken lines that matched, most relevant first. */
  lines: Line[];
  more: boolean;
  /** A recap sentence or action item that matched, when no line did. */
  recap: string | null;
};

/** The words of a query, lowercased; a hit must hold every one. */
export function termsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The first recap part (summary sentence, then action items) holding a term. */
function recapHit(call: any, terms: string[]): string | null {
  const sentences: string[] = (call.summary ?? "").split(/(?<=[.!?])\s+/);
  for (const part of [...sentences, ...((call.action_items ?? []) as string[])]) {
    const low = part.toLowerCase();
    if (terms.some((t) => low.includes(t))) return part;
  }
  return null;
}

export function useCallSearch(
  calls: any[],
  places: Record<string, CallPlace | null | undefined>,
  query: string,
): { results: CallSearchResult[] | null; searching: boolean } {
  const q = query.trim();
  const settled = useDebounce(q, 180);
  const words = useQueryNoThrow(api.transcripts.webSearchCalls, settled.length >= 2 ? { q: settled } : "skip");
  const results = useMemo(() => {
    if (!q) return null;
    const terms = termsOf(q);
    const spoken = new Map((words.data ?? []).map((w) => [String(w._id), w]));
    const store = useInboxStore.getState() as any;
    const out: CallSearchResult[] = [];
    for (const call of calls) {
      const id = String(call._id);
      const said = spoken.get(id);
      const haystack = [
        callTitle({ ...call, place: places[id] }, store),
        ...((call.participants ?? []) as Array<{ name: string }>).map((p) => p.name),
        call.summary ?? "",
        ...((call.action_items ?? []) as string[]),
      ]
        .join("\n")
        .toLowerCase();
      const meta = terms.every((t) => haystack.includes(t));
      if (!meta && !said) continue;
      out.push({
        call,
        lines: said?.lines ?? [],
        more: !!said?.more,
        recap: said ? null : recapHit(call, terms),
      });
    }
    return out;
  }, [calls, places, q, words.data]);
  // The words answer lags the keystroke: the debounce, then the server.
  const searching = q.length >= 2 && (settled !== q || (words.data === undefined && !words.error));
  return { results, searching };
}

export function CallSearchField({
  value,
  onChange,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="cs-field" role="search">
      <Search className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" aria-hidden="true" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (value) onChange("");
            else e.currentTarget.blur();
          }
        }}
        placeholder="Search calls and what was said"
        aria-label="Search calls"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent text-[12px] text-sol-text outline-none placeholder:text-sol-text-dim"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          className="rounded p-0.5 text-sol-text-dim transition-colors hover:text-sol-text"
          aria-label="Clear search"
          title="Clear"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** `text` with each term marked, cut to a window around the first one. */
export const Marked = memo(function Marked({ text, terms, around = 0 }: { text: string; terms: string[]; around?: number }) {
  let shown = text;
  let lead = false;
  if (around > 0) {
    const low = text.toLowerCase();
    const first = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0), Infinity);
    if (first !== Infinity && first > around) {
      const cut = text.lastIndexOf(" ", first - around);
      shown = text.slice(cut > 0 ? cut + 1 : first - around);
      lead = true;
    }
  }
  const escaped = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = escaped.length ? shown.split(new RegExp(`(${escaped.join("|")})`, "gi")) : [shown];
  return (
    <>
      {lead && "…"}
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i} className="cs-mark">{p}</mark> : p))}
    </>
  );
});

/** What matched inside one found call: its spoken lines (each opens the
 *  call at that line), or the recap sentence that matched. */
export function CallSearchHits({ result, terms }: { result: CallSearchResult; terms: string[] }) {
  const ref = callPathRef(result.call);
  if (result.lines.length === 0 && !result.recap) return null;
  return (
    <div className="cs-hits">
      {result.lines.map((l) => (
        <Link
          key={l.seq}
          href={callAnchorHref(ref, { kind: "turns", from_seq: l.seq, to_seq: l.seq })}
          className="cs-hit"
          title={`Open the call at ${formatCallTime(l.t0)}`}
        >
          <span className="cs-hit-time">{formatCallTime(l.t0)}</span>
          <span className="cs-hit-text">
            <span className={speakerColor(l.speaker_id)}>{firstName(l.speaker_name)}</span>{" "}
            <Marked text={l.text} terms={terms} around={36} />
          </span>
        </Link>
      ))}
      {result.recap && (
        <Link href={callAnchorHref(ref, { kind: "summary" })} className="cs-hit" title="Open the call's recap">
          <span className="cs-hit-time">recap</span>
          <span className="cs-hit-text">
            <Marked text={result.recap} terms={terms} around={36} />
          </span>
        </Link>
      )}
    </div>
  );
}
