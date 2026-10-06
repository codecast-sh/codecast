import { useCallback, useEffect, useRef, useState } from "react";

/** Copy text; `copied` names what was copied for 1.5s, for the "Copied" swap. */
export function useCopy(): { copied: string | null; copy: (key: string, text: string) => void } {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback((key: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 1500);
  }, []);
  return { copied, copy };
}
