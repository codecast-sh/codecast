// The lane switch in settings: on puts the person in the simple lane (the
// hosted assistant's calm home), off returns them to the full app. The lane
// itself carries the way back in its own menu (SimpleShell's LaneMenu).
import { Switch } from "../ui/switch";
import { SettingsRow } from "../settings/ui";
import { useInboxStore } from "../../store/inboxStore";
import { LANE_SWITCH, laneOf } from "./lanePref";
import { useSetLane } from "./useSetLane";

export function LaneSettingRow() {
  const simple = useInboxStore((s) => laneOf(s.clientState?.ui) === "simple");
  const setLane = useSetLane();
  return (
    <SettingsRow
      label={LANE_SWITCH.label}
      description={LANE_SWITCH.description}
    >
      <Switch checked={simple} onCheckedChange={(on) => setLane(on ? "simple" : "full")} aria-label={LANE_SWITCH.label} />
    </SettingsRow>
  );
}
