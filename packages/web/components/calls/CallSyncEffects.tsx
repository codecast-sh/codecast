import { useCallSync } from "../../hooks/useCallSync";
import { useRecorderSync } from "../../hooks/useRecorder";
import { useCallRing } from "../../hooks/useCallRing";
import { useWalkieSync } from "../../hooks/useWalkieSync";
import { useRoomThreadAlerts } from "../../hooks/useRoomThreadAlerts";

export function CallSyncEffects() {
  useCallSync();
  useCallRing();
  useWalkieSync();
  useRecorderSync();
  useRoomThreadAlerts();
  return null;
}
