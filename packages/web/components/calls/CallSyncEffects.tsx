import { useCallSync } from "../../hooks/useCallSync";
import { useRecorderSync } from "../../hooks/useRecorder";
import { useCallRing } from "../../hooks/useCallRing";
import { useWalkieSync } from "../../hooks/useWalkieSync";

export function CallSyncEffects() {
  useCallSync();
  useCallRing();
  useWalkieSync();
  useRecorderSync();
  return null;
}
