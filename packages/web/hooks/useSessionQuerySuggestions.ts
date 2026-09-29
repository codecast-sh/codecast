import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { sessionQueryCompletion, type SessionQueryCompletion } from "@codecast/shared/search";
import { useInboxStore } from "../store/inboxStore";
import { useQueryNoThrow } from "./useQueryNoThrow";
import {
  reposFromSessions,
  sessionQuerySuggestions,
  type QuerySuggestion,
  type SuggestionSources,
} from "../lib/sessionQuerySuggestions";

/**
 * Autocomplete rows for a session query at the caret. Store data is read once
 * per keystroke (getState), not subscribed: the search box and the palette
 * only need the lists as they stand when the user types, and a subscription to
 * sessions or pull requests would re-render them on every heartbeat. File
 * paths are the one source the store does not hold, so `file:` alone asks the
 * server, and only while it is being typed.
 */
export function useSessionQuerySuggestions(
  input: string,
  caret: number = input.length,
): { completion: SessionQueryCompletion | null; suggestions: QuerySuggestion[] } {
  const completion = useMemo(() => sessionQueryCompletion(input, caret), [input, caret]);
  const op = completion?.kind === "value" ? completion.op : null;
  const { data: files } = useQueryNoThrow(api.sessionQuerySuggest.recentFiles, op === "file" ? {} : "skip");

  const suggestions = useMemo(() => {
    if (!completion) return [];
    const s = useInboxStore.getState();
    const src: SuggestionSources = { files };
    if (op === "label") {
      src.labels = Object.values(s.buckets ?? {})
        .filter((b) => !b.archived_at)
        .sort((a, b) => b.updated_at - a.updated_at)
        .map((b) => b.name);
    } else if (op === "author") {
      src.people = s.teamMembers ?? [];
    } else if (op === "repo") {
      src.repos = reposFromSessions(Object.values(s.sessions ?? {}) as any);
    } else if (op === "pr") {
      src.prs = (Object.values(s.pullRequests ?? {}) as any[]).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    } else if (op === "commit") {
      src.commits = (Object.values(s.commits ?? {}) as any[]).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    }
    return sessionQuerySuggestions(completion, src);
  }, [completion, op, files]);

  return { completion, suggestions };
}
