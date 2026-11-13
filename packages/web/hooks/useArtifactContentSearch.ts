// Search the words inside boards, sheets and dashboards (convex liveSearch).
// A list feeds it its search box's text; it answers which docs matched and
// the words that matched, for the row. Results are the answer to one query
// string, not synced data: they live here for as long as the query does.
import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useDebounce } from "./useDebounce";

export function useArtifactContentSearch(): {
  setQuery: (q: string) => void;
  matches: (doc: { _id: string }) => boolean;
  snippets: Map<string, string>;
  /** Every hit, with where it lives, for a list that shows hits from outside its own workspace. */
  hits: Array<{ _id: string; title: string; doc_type: string; snippet: string; updated_at?: number; where: string }>;
  /** The query being answered (trimmed, debounced). */
  query: string;
  /** Whether the content answer for these typed words (the list's own query, read in the same render) is still on its way. */
  pendingFor: (typed: string) => boolean;
} {
  const [query, setQuery] = useState("");
  const q = useDebounce(query.trim(), 250);
  const { data: answer, error } = useQueryNoThrow(api.liveSearch.search, q.length >= 2 ? { query: q, limit: 20 } : "skip");
  // While more letters of the same words are on their way, the last answer stays on screen, so rows don't
  // flash out and back. New words drop it: rows for the old words would read as wrong results.
  const last = useRef<{ q: string; data: unknown }>({ q: "", data: undefined });
  if (answer !== undefined) last.current = { q, data: answer };
  const data = answer ?? (q.length >= 2 && last.current.q && q.startsWith(last.current.q) ? last.current.data : undefined);
  // An answer counts only for the words still typed: replacing them drops it at once, not a debounce later.
  const typedExtends = query.trim().toLowerCase().startsWith(q.toLowerCase());
  const snippets = useMemo(() => {
    const m = new Map<string, string>();
    if (q.length >= 2 && typedExtends) for (const h of (data as any[] | undefined) ?? []) m.set(String(h._id), String(h.snippet ?? ""));
    return m;
  }, [data, q, typedExtends]);
  const matches = useCallback((doc: { _id: string }) => snippets.has(doc._id), [snippets]);
  const hits = useMemo(() => (q.length >= 2 && typedExtends ? ((data as any[] | undefined) ?? []) : []), [data, q, typedExtends]);
  const pendingFor = useCallback(
    (typed: string) => typed.trim().length >= 2 && (q !== typed.trim() || (answer === undefined && !error)),
    [q, answer, error],
  );
  return { setQuery, matches, snippets, hits, query: q, pendingFor };
}
