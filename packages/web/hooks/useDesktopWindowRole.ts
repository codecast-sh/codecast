import { useSyncExternalStore } from "react";
import {
  getDesktopWindowRole,
  subscribeWindowRole,
  type DesktopWindowRole,
} from "../lib/desktop";

/**
 * This window's role among the desktop's windows, as a React value.
 *
 * The role is pushed by the shell into a module variable; the sound paths read
 * it on demand, but anything that DRAWS it needs to re-render when it changes.
 * Outside the desktop nothing ever pushes, so this is a constant and the
 * subscription costs one Set entry.
 */
export function useDesktopWindowRole(): DesktopWindowRole {
  return useSyncExternalStore(subscribeWindowRole, getDesktopWindowRole, getDesktopWindowRole);
}
