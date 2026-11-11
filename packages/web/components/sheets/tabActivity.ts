// Which tabs an agent wrote to since this page last showed them. Writes that
// predate the page (history) never count; showing a tab marks it seen.
import { useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import type { SheetModel, TabData } from "./sheetCore";

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

/**
 * The cells an agent session wrote that this page hasn't shown yet: on the
 * open tab as they land, and on a tab you come back to, everything written
 * there since you last looked. They flash once so a person sees what moved.
 */
export function useAgentFlash(tab: TabData): Set<string> | undefined {
  const [flash, setFlash] = useState<Set<string> | undefined>(undefined);
  /** When this page opened: only writes after it are news. */
  const [since] = useState(() => Date.now());
  /** Per tab, the newest revision this page has shown there. */
  const shown = useRef(new Map<string, number>());
  useWatchEffect(() => {
    const id = tab.meta.id;
    const before = shown.current.get(id) ?? -1;
    let max = before;
    const hits = new Set<string>();
    for (const [n, el] of tab.cells) {
      if (el.rev > max) max = el.rev;
      if (el.rev > before && (el.at ?? 0) > since && typeof el.by === "string" && el.by.startsWith("s:")) hits.add(`${n % 32768}:${Math.floor(n / 32768)}`);
    }
    shown.current.set(id, max);
    if (!hits.size) return;
    setFlash(hits);
    const t = setTimeout(() => setFlash(undefined), 2200);
    return () => clearTimeout(t);
  }, [tab, since]);
  return flash;
}
