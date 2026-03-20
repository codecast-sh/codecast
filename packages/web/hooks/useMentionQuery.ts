import { useCallback, useRef } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { MentionItem } from "../components/editor/MentionList";

const api = _api as any;

export function useMentionQuery() {
  const mentionResults = useQuery(api.docs.mentionSearch, { query: "", limit: 20 });
  const ref = useRef<MentionItem[]>([]);
  if (mentionResults) ref.current = mentionResults;

  return useCallback(async (q: string): Promise<MentionItem[]> => {
    const results = ref.current;
    if (!results.length) return [];
    const lower = q.toLowerCase();
    if (!lower) return results;
    return results.filter(
      (r) =>
        r.label.toLowerCase().includes(lower) ||
        (r.sublabel && r.sublabel.toLowerCase().includes(lower))
    );
  }, []);
}
