// Opening the keyboard settings on one action, recording: the "?" panel's rows
// and the palette land there. The request waits here until the panel mounts
// and takes it.
import type { ShortcutAction } from "../shortcuts/registry";
import { useInboxStore } from "../store/inboxStore";

let pending: ShortcutAction | null = null;

export function rebindShortcut(action?: ShortcutAction): void {
  pending = action ?? null;
  useInboxStore.getState().openSettingsModal("keyboard");
}

export function takePendingRebind(): ShortcutAction | null {
  const a = pending;
  pending = null;
  return a;
}
