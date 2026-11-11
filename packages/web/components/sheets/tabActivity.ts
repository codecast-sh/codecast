// Which tabs an agent wrote to since this page last showed them. Writes that
// predate the page (history) never count; showing a tab marks it seen.
import { useRef, useState } from "react";
import type { SheetModel } from "./sheetCore";

export function unseenTabs(model: SheetModel, activeTabId: string, seen: Map<string, number>, since: number): Set<string> {
  const out = new Set<string>();
  for (const [id, t] of model.byId) {
    const w = t.agentWrite;
    if (!w) continue;
    if (id === activeTabId) {
      seen.set(id, w.rev);
      continue;
    }
    if ((w.at ?? 0) > since && w.rev > (seen.get(id) ?? -1)) out.add(id);
  }
  return out;
}

export function useUnseenTabs(model: SheetModel, activeTabId: string): Set<string> {
  const seen = useRef(new Map<string, number>());
  const [since] = useState(() => Date.now());
  const next = unseenTabs(model, activeTabId, seen.current, since);
  // Hand back the same Set while the answer holds, so the strip skips its render.
  const last = useRef(next);
  if (next.size !== last.current.size || [...next].some((id) => !last.current.has(id))) last.current = next;
  return last.current;
}
