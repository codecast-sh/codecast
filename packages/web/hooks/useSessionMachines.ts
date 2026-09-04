import { useMemo } from "react";
import { useDevices } from "../components/DeviceBadge";
import { sessionMachineChoices } from "../lib/sessionMachines";
import { useSettingsData } from "./useSyncSettings";

export function useSessionMachines() {
  const { devices } = useDevices();
  const { data: boxes } = useSettingsData("agentBoxes");
  return useMemo(() => sessionMachineChoices(devices, boxes ?? []), [devices, boxes]);
}
