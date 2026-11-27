// The folder the new-session sheet opens in for a milestone's Start: one
// mapped to the priority's team (web lib/priorityStartFolder), so the
// session's link can hold; sharing stays what the folder gives.
import type { SessionStart } from '@codecast/web/store/composeSlice';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { startFolderInStore } from '@codecast/web/lib/priorityStartFolder';
import { useSettingsData } from '@codecast/web/hooks/useSyncSettings';

export function useStartFolderPath(start: SessionStart | null | undefined): string | null {
  useSettingsData('directoryMappings');
  return useInboxStore((s) => {
    return (start?.priority ? startFolderInStore(s, start.priority)?.path : null) ?? null;
  });
}
