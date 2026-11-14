// The calls list's search: what a call is called, who was in it, its recap,
// matched from the list the page already holds on the keystroke, and every
// word said in it from the server's search over spoken lines
// (transcripts.webSearchCalls). Drawn by components/calls/CallSearch.

import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useDebounce } from "./useDebounce";
import { useInboxStore } from "../store/inboxStore";
import { callTitle, type CallPlace } from "../lib/calls/roomLabels";

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
