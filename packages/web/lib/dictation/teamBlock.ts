// Why the person may not dictate (shared rule: dictationTeamBlock), as a
// store selector for the mic (DictateControls) and Settings › Voice.
import { dictationTeamBlock } from "@codecast/shared/contracts/dictation";

export const openAiBlock = (s: { teams?: unknown[] }): string | null => dictationTeamBlock(s.teams);
