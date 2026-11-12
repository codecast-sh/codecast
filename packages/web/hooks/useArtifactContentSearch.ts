// Search the words inside boards, sheets and dashboards (convex liveSearch).
// A list feeds it its search box's text; it answers which docs matched and
// the words that matched, for the row. Results are the answer to one query
// string, not synced data: they live here for as long as the query does.
import { useCallback, useMemo, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useDebounce } from "./useDebounce";

export function useArtifactContentSearch(): {
  setQuery: (q: string) => void;
  matches: (doc: { _id: string }) => boolean;
  snippets: Map<string, string>;
  /** Every hit, with where it lives, for a list that shows hits from outside its own workspace. */
  hits: Array<{ _id: string; title: string; doc_type: string; snippet: string; updated_at?: number; where: string }>;
} {
  const [query, setQuery] = useState("");
  const q = useDebounce(query.trim(), 250);
  const { data } = useQueryNoThrow(api.liveSearch.search, q.length >= 2 ? { query: q, limit: 20 } : "skip");
  const snippets = useMemo(() => {
    const m = new Map<string, string>();
    if (q.length >= 2) for (const h of (data as any[] | undefined) ?? []) m.set(String(h._id), String(h.snippet ?? ""));
    return m;
  }, [data, q]);
  const matches = useCallback((doc: { _id: string }) => snippets.has(doc._id), [snippets]);
  const hits = useMemo(() => (q.length >= 2 ? ((data as any[] | undefined) ?? []) : []), [data, q]);
  return { setQuery, matches, snippets, hits };
}
