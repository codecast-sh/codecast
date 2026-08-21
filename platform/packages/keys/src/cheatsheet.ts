// Cheat sheet generation, unified across the two keyboard layers. Both the
// chord engine (sequences + context stack) and the action catalog (flat chord
// defs) can describe their live keymap as the same entry shape, so one help
// overlay renders either — or both merged.

import { KeyEngine, KeyContext, parseSpec, tokenParts } from './engine';
import { ShortcutCatalog } from './catalog';

export interface CheatSheetEntry {
  /** Keycaps to render: outer array = chords pressed in order (a vim-style
      sequence has several; a flat chord has one), inner = caps within one
      chord. */
  keys: string[][];
  description: string;
  /** Group heading for the overlay. */
  group: string;
}

/** The engine's live keymap for one context, hidden bindings omitted. */
export function engineCheatSheet(engine: KeyEngine, context: KeyContext): CheatSheetEntry[] {
  return engine
    .activeFor(context)
    .filter((b) => !b.hidden)
    .map((b) => ({
      keys: parseSpec(b.keys).map((token) => tokenParts(token)),
      description: b.description,
      group: b.group,
    }));
}

/** The catalog's bindings for one context tag (undefined = the global ones). */
export function catalogCheatSheet<A extends string>(
  catalog: ShortcutCatalog<A>,
  when?: string,
): CheatSheetEntry[] {
  return catalog.getShortcutsByContext(when).map((def) => ({
    keys: [catalog.formatShortcutParts(def)],
    description: def.description,
    group: def.when ?? 'global',
  }));
}
