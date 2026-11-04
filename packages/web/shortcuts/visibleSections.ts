// The shortcut sections a person sees, in HELP_SECTIONS order: the Flows
// context only where the workspace has Flows, and each action listed once (in
// the first context that has it). The "?" panel lists the live bindings; the
// keyboard settings list every action, unbound ones included.
import type { ShortcutAction, ShortcutDef } from "./registry";
import { HELP_SECTIONS } from "./sections";

export interface ShortcutSection {
  when: string | undefined;
  label: string;
  accent: string;
  actions: { action: ShortcutAction; label: string; def: ShortcutDef }[];
}

/** `flowsOn`: the workspace has the Flows feature on (teamFeatures "line"). */
export function visibleShortcutSections(flowsOn: boolean, defsIn: (when: string | undefined) => ShortcutDef[]): ShortcutSection[] {
  const seen = new Set<string>();
  const out: ShortcutSection[] = [];
  for (const { when, label, accent } of HELP_SECTIONS) {
    if (when === "line" && !flowsOn) continue;
    const actions = defsIn(when)
      .filter((d) => {
        if (seen.has(d.action)) return false;
        seen.add(d.action);
        return true;
      })
      .map((d) => ({ action: d.action, label: d.description, def: d }));
    out.push({ when, label, accent, actions });
  }
  return out;
}
