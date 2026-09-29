import { useMemo, useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { applySessionQueryCompletion, sessionQueryCompletion, type SessionQueryCompletion } from "@codecast/shared/search";
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

/**
 * The autocomplete behaviour every session search input shares: the caret
 * decides which token completes; Escape hides the list until the text changes;
 * a value list preselects its first row (a dangling operator is not a search
 * yet), an operator-name list does not (the word may just be text), so Enter
 * still falls through to the input's own handling there. The input spreads
 * `inputHandlers`, reports caret moves from onChange through `trackCaret`,
 * calls `onKeyDown` first (true means it handled the key), and renders
 * SessionQuerySuggestList with `listProps` while `open`.
 */
export function useSessionQueryAutocomplete(
  query: string,
  setQuery: (value: string) => void,
  inputRef: RefObject<HTMLInputElement | null>,
  initiallyFocused = false,
) {
  const [caret, setCaret] = useState<number | null>(null);
  const [focused, setFocused] = useState(initiallyFocused);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pick, setPick] = useState<{ key: string; index: number } | null>(null);
  const caretAt = Math.min(caret ?? query.length, query.length);
  const { completion, suggestions } = useSessionQuerySuggestions(query, caretAt);
  const key = `${query}|${caretAt}`;
  const open = focused && suggestions.length > 0 && dismissed !== query;
  const selected =
    pick?.key === key ? Math.min(pick.index, suggestions.length - 1) : completion?.kind === "value" ? 0 : -1;

  const accept = (s: QuerySuggestion) => {
    if (!completion) return;
    const next = applySessionQueryCompletion(query, completion, s.text);
    setQuery(next.value);
    setCaret(next.caret);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.caret, next.caret));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = suggestions.length;
      setPick({ key, index: e.key === "ArrowDown" ? (selected + 1) % n : (selected - 1 + n) % n });
      return true;
    }
    if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && selected >= 0 && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      accept(suggestions[Math.max(selected, 0)]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(query);
      return true;
    }
    return false;
  };

  return {
    open,
    onKeyDown,
    trackCaret: (el: HTMLInputElement) => setCaret(el.selectionStart),
    resetCaret: () => setCaret(null),
    inputHandlers: {
      onSelect: (e: SyntheticEvent<HTMLInputElement>) => setCaret(e.currentTarget.selectionStart),
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
    },
    listProps: { suggestions, selected, onPick: accept, onHover: (index: number) => setPick({ key, index }) },
  };
}
