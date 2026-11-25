"use client";

import { toast } from "sonner";
import { MenuKeyCaps } from "../components/KeyboardShortcutsHelp";

// Shown when a row verb's key had no session to act on (lib/hoverTarget):
// the pointer is off the rows, or another row shows its toolbar.
export function showRowVerbHint(): void {
  toast(
    <span data-row-verb-hint className="inline-flex flex-wrap items-center gap-1">
      Hover a session, or press
      <MenuKeyCaps action="session.next" className="inline-flex items-center gap-[2px]" />
      <MenuKeyCaps action="session.prev" className="inline-flex items-center gap-[2px]" />
      to choose one
    </span>,
    { id: "row-verb-hint", duration: 2500 },
  );
}
