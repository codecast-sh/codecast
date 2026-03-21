import { useCallback, useRef } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { MentionItem } from "../components/editor/MentionList";
import { useInboxStore } from "../store/inboxStore";

const api = _api as any;

export function useMentionQuery(projectPath?: string | null) {
  const storeSession = useInboxStore((s) => {
    const id = s.currentSessionId;
    return id ? s.sessions[id] : null;
  });
  const resolvedPath = projectPath || storeSession?.project_path || storeSession?.git_root || null;
  const mentionResults = useQuery(api.docs.mentionSearch, { query: "", limit: 20, ...(resolvedPath ? { projectPath: resolvedPath } : {}) });
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
