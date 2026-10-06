import type { ReactNode } from "react";
import { KeyCap } from "../../../web/components/KeyCap";

/** Keyboard keys, always as KeyCaps restyled by `.keys kbd` (base.css). */
export function Keys({ keys, children }: { keys: string[]; children?: ReactNode }) {
  return (
    <span className="keys">
      {keys.map((k) => (
        <KeyCap key={k}>{k}</KeyCap>
      ))}
      {children}
    </span>
  );
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";
