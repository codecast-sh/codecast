// Does this build have the desktop shell's native browser view?
//
// The bridge existing proves nothing: every desktop build carries the generic
// app IPC call, and one from before the native pane shipped simply rejects the
// name. The only proof is the shell's own capability answer, which arrives a
// tick after boot — so this is a subscription, not a read.
//
// It lives in hooks/ rather than beside the backend that uses it because a
// .tsx file that exports a hook next to a component is a broken Fast Refresh
// boundary (lib/__tests__/fastRefreshBoundaries.guard.test.ts).
import { useSyncExternalStore } from "react";
import { nativeBrowserPaneAvailable, subscribeNativeBrowserPane } from "../lib/desktop";

export function useNativeBrowserPane(): boolean {
  return useSyncExternalStore(subscribeNativeBrowserPane, nativeBrowserPaneAvailable, () => false);
}
