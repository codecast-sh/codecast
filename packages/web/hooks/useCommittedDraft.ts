import { useRef, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";

/**
 * A field's draft over a stored value: follows writes from elsewhere (an
 * agent, another tab) while the field isn't being edited, and never throws
 * away what the person typed, even input that can't be committed yet.
 */
export function useCommittedDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useWatchEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  return {
    draft,
    setDraft,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
    },
  };
}
