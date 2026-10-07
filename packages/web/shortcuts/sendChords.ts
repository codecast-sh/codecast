import type { DevSurface } from "../lib/surfaceRules";

// The composer's own send chords. They are handled inline in the composer's
// keydown handler (they must run from a focused textarea, which the global
// registry never does), so this table is their one source of truth: the
// shortcuts panel renders it as the Composer section, and nothing else
// spells these keys out. Accelerators use registry syntax so
// formatAcceleratorParts renders them with the same glyphs as every other
// chord in the app.
// `surface` names the developer surface a chord belongs to (lib/surfaceRules),
// so the panel leaves it out where that surface is hidden, as the palette
// leaves out the matching actions.
export const SEND_CHORDS: ReadonlyArray<{ accel: string; label: string; surface?: DevSurface }> = [
  { accel: "enter", label: "Send" },
  { accel: "shift+enter", label: "New line" },
  { accel: "ctrl+enter", label: "Queue for later", surface: "actions.fleet" },
  { accel: "alt+enter", label: "Send and advance" },
  { accel: "alt+shift+enter", label: "Send and stash", surface: "actions.fleet" },
  { accel: "meta+shift+enter", label: "Fork and send", surface: "actions.fleet" },
  { accel: "meta+alt+enter", label: "Send together with others' drafts", surface: "actions.fleet" },
  { accel: "meta+shift+e", label: "Rich editor", surface: "actions.fleet" },
  { accel: "alt+shift+h", label: "Hand off to a teammate", surface: "composer.handoff" },
];
