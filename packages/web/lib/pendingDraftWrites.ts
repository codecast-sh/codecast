// The composer writes its draft to the store on a short debounce so typing
// doesn't rewrite the drafts collection on every keystroke. Anything that
// decides a draft's fate from the store (a dismissal choosing keep, confirm
// or prune) must flush first, or the last keystrokes are invisible to it and
// the draft is dropped. One pending write per draft id.

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; write: () => void }>();

let exitHooked = false;
function hookPageExit() {
  if (exitHooked || typeof window === "undefined") return;
  exitHooked = true;
  const flushAll = () => { for (const id of [...pending.keys()]) flushDraftWrite(id); };
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushAll(); });
}

export function scheduleDraftWrite(id: string, write: () => void, delayMs = 300): void {
  cancelDraftWrite(id);
  hookPageExit();
  const timer = setTimeout(() => { pending.delete(id); write(); }, delayMs);
  pending.set(id, { timer, write });
}

export function cancelDraftWrite(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
}

export function flushDraftWrite(id: string | null | undefined): void {
  if (!id) return;
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.write();
}
