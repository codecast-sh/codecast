// Settings › Voice writes. Both switches live on currentUser (localFirst) and
// the sample counts in the myVoiceprint singleton (localFirst); each action
// paints the draft in the same tick and rides `dispatch` to the side effect of
// the same name (convex/dispatch.ts).
import { asyncAction } from "./mutativeMiddleware";

/** voiceprints.myVoiceprint, as the store holds it. */
export type MyVoiceprint = { count: number; seconds: number; last_added_at: number | null };

export type VoiceSettingsSliceActions = {
  /** The viewer's voice recognition switch, `currentUser.voice_id_enabled`
   *  (voiceprints.setVoiceIdEnabled). Off deletes every sample, so the
   *  myVoiceprint counts go to zero on the press too. */
  setVoiceIdEnabled: (enabled: boolean) => Promise<unknown>;
  /** Delete every sample of the viewer's voice (voiceprints.deleteMyVoiceprints). */
  deleteMyVoiceprints: () => Promise<unknown>;
  /** `currentUser.dictation_enabled` (dictation.setDictationEnabled): the
   *  composer mic shows only while it is on. */
  setDictationEnabled: (enabled: boolean) => Promise<unknown>;
};

type VoiceSettingsDraft = {
  currentUser?: Record<string, unknown> | null;
  myVoiceprint: MyVoiceprint | null;
};

function clearVoiceSamples(mine: MyVoiceprint) {
  mine.count = 0;
  mine.seconds = 0;
  mine.last_added_at = null;
}

export function createVoiceSettingsSlice(): VoiceSettingsSliceActions {
  return {
    setVoiceIdEnabled: asyncAction(function (this: VoiceSettingsDraft, enabled: boolean) {
      if (this.currentUser) this.currentUser.voice_id_enabled = enabled;
      if (this.myVoiceprint && !enabled) clearVoiceSamples(this.myVoiceprint);
      return { enabled };
    }) as unknown as VoiceSettingsSliceActions["setVoiceIdEnabled"],
    deleteMyVoiceprints: asyncAction(function (this: VoiceSettingsDraft) {
      if (this.myVoiceprint) clearVoiceSamples(this.myVoiceprint);
    }) as unknown as VoiceSettingsSliceActions["deleteMyVoiceprints"],
    setDictationEnabled: asyncAction(function (this: VoiceSettingsDraft, enabled: boolean) {
      if (this.currentUser) this.currentUser.dictation_enabled = enabled;
      return { enabled };
    }) as unknown as VoiceSettingsSliceActions["setDictationEnabled"],
  };
}
