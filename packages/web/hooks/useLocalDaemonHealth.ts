import { useDaemonHealth } from "./useDaemonHealth";
import { useLocalDeviceId } from "./useLocalDeviceId";

export function useLocalDaemonHealth() {
  return useDaemonHealth(useLocalDeviceId(true));
}
