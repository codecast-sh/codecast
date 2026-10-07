import type { ReactNode } from "react";
import { KeyCap } from "../../../web/components/KeyCap";

/** Keyboard keys, always as KeyCaps restyled by `.keys kbd` (base.css).
 *  Inside a control they are for eyes only (`hidden`): the control says its
 *  shortcut with `aria-keyshortcuts`. */
export function Keys({ keys, hidden = false, children }: { keys: string[]; hidden?: boolean; children?: ReactNode }) {
  return (
    <span className="keys" aria-hidden={hidden || undefined}>
      {keys.map((k) => (
        <KeyCap key={k}>{k}</KeyCap>
      ))}
      {children && <span className="label">{children}</span>}
    </span>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";
/** The modifier as `aria-keyshortcuts` names it. */
export const MOD_ARIA = isMac ? "Meta" : "Control";
