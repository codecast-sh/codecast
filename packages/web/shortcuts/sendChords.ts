// The composer's own send chords. They are handled inline in the composer's
// keydown handler (they must run from a focused textarea, which the global
// registry never does), so this table is their one source of truth: the
// shortcuts panel renders it as the Composer section, and nothing else
// spells these keys out. Accelerators use registry syntax so
// formatAcceleratorParts renders them with the same glyphs as every other
// chord in the app.
export const SEND_CHORDS: ReadonlyArray<{ accel: string; label: string }> = [
  { accel: "enter", label: "Send" },
  { accel: "shift+enter", label: "New line" },
  { accel: "ctrl+enter", label: "Queue for later" },
  { accel: "alt+enter", label: "Send and advance" },
  { accel: "alt+shift+enter", label: "Send and stash" },
  { accel: "meta+shift+enter", label: "Fork and send" },
  { accel: "meta+shift+e", label: "Rich editor" },
];
