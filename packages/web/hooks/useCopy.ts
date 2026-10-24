import { useRef, useState } from "react";
import { useMountEffect } from "./useMountEffect";

/**
 * Copy text and say how it went for a moment: `state` is "copied" or "failed"
 * for 1.4s after a press, then "idle" again. `get` may fetch the text first;
 * none, or a clipboard that refuses, is a failure.
 */
export function useCopy() {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useMountEffect(() => () => clearTimeout(reset.current));
  const show = (next: "copied" | "failed") => {
    setState(next);
    clearTimeout(reset.current);
    reset.current = setTimeout(() => setState("idle"), 1400);
  };
  const copy = async (get: () => Promise<string | undefined> | string | undefined) => {
    try {
      const text = await get();
      if (!text) return show("failed");
      await navigator.clipboard.writeText(text);
      show("copied");
    } catch {
      show("failed");
    }
  };
  return { state, copy };
}
