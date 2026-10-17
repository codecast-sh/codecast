// The shortcut sections a person sees, in HELP_SECTIONS order: a context whose
// surface this mode hides is left out, each action is listed once (in the
// first context that has it) and only where the palette would list it, named
// in this mode's words. The "?" panel lists the live bindings; the keyboard
// settings list every action, unbound ones included.
import type { ShortcutAction, ShortcutDef } from "./registry";
import { HELP_SECTIONS } from "./sections";
import { MODE_WORDS, actionLabel, actionShownIn, helpContextSurface } from "../lib/surfaces";
import type { SurfaceMode } from "../lib/surfaceRules";

/** Hosted mode names these sections by its pages. */
const HOSTED_LABELS: Record<string, string> = { Tasks: MODE_WORDS.hosted.tasksPage, Docs: MODE_WORDS.hosted.docsPage };

export interface ShortcutSection {
  when: string | undefined;
  label: string;
  accent: string;
  actions: { action: ShortcutAction; label: string; def: ShortcutDef }[];
}

export function visibleShortcutSections(mode: SurfaceMode, defsIn: (when: string | undefined) => ShortcutDef[]): ShortcutSection[] {
  const hosted = mode.words === MODE_WORDS.hosted;
  const seen = new Set<string>();
  const out: ShortcutSection[] = [];
  for (const { when, label, accent } of HELP_SECTIONS) {
    const surface = helpContextSurface(when);
    if (surface && !mode.shows(surface)) continue;
    const actions = defsIn(when)
      .filter((d) => {
        if (seen.has(d.action)) return false;
        seen.add(d.action);
        return actionShownIn(mode, d.action);
      })
      .map((d) => ({ action: d.action, label: actionLabel(d.action, d.description, hosted), def: d }));
    out.push({
      when,
      label: hosted ? HOSTED_LABELS[label] ?? label : label,
      // Hosted mode draws every dot in quiet ink rather than a colour per context.
      accent: hosted ? "bg-sol-text-dim" : accent,
      actions,
    });
  }
  return out;
}
