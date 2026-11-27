// The folder the new-session sheet opens in for a milestone's Start: one whose
// rule shares with the priority's team (web lib/priorityStartFolder), so the
// session's link holds. The sheet has no what-the-team-sees picker, so a
// folder that would need Summary picked is never chosen here: the person picks
// the folder, and the refusal alert explains.
import type { SessionStart } from '@codecast/web/store/composeSlice';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { startFolderInStore } from '@codecast/web/lib/priorityStartFolder';
import { useSettingsData } from '@codecast/web/hooks/useSyncSettings';

export function useStartFolderPath(start: SessionStart | null | undefined): string | null {
  useSettingsData('directoryMappings');
  return useInboxStore((s) => {
    const folder = start?.priority ? startFolderInStore(s, start.priority) : null;
    return folder && !folder.visibility ? folder.path : null;
  });
}
