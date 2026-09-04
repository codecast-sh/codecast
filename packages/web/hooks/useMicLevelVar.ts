import { useCallback } from "react";
import { getMicLevel, subscribeMicLevel } from "../lib/calls/callManager";

export function useMicLevelVar<T extends HTMLElement>(active: boolean) {
  return useCallback((el: T | null) => {
    if (!el) return;
    const write = () => el.style.setProperty("--level", active ? getMicLevel().toFixed(3) : "0");
    write();
    if (!active) return;
    const off = subscribeMicLevel(write);
    return () => {
      off();
      el.style.setProperty("--level", "0");
    };
  }, [active]);
}
