import { useState } from "react";

// Chat and Tasks are doors in the sidebar: their lists (every room, every saved
// view) are a level of their own that slides over the app nav, with a back row
// (and Shift with the sidebar toggle's chord) to slide out. Arriving on a
// section's page opens its level; only Back or another door closes it, so
// opening a session from the side panel keeps you in Chat.

export type DrillLevel = "chat" | "tasks";

export function useSidebarDrill(section: DrillLevel | null, available: Record<DrillLevel, boolean>) {
  const [s, set] = useState<{ section: DrillLevel | null; level: DrillLevel | null; shown: DrillLevel | null }>({
    section,
    level: section,
    shown: section,
  });
  // Arriving on another section opens its level: render-phase, so the first
  // paint on the new page already shows it. Leaving for a page of no section
  // keeps whatever level is open.
  if (s.section !== section) set({ section, level: section ?? s.level, shown: section ?? s.shown });
  const level = s.level && available[s.level] ? s.level : null;
  return {
    level,
    // The pane keeps its content while it slides out.
    shown: level ?? s.shown,
    back: () => set((p) => ({ ...p, level: null })),
    open: (l: DrillLevel) => set((p) => ({ ...p, level: l, shown: l })),
  };
}
