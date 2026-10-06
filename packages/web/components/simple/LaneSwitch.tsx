// The hosted mode switch in settings: on is hosted mode (ui.lane "simple"),
// off the developer default. The main app follows the preference where the
// person is (lib/surfaces.ts), so the switch only writes it.
import { Switch } from "../ui/switch";
import { SettingsRow } from "../settings/ui";
import { useHostedMode } from "../../lib/surfaces";
import { LANE_SWITCH, writeLane } from "./lanePref";

export function LaneSettingRow() {
  const hosted = useHostedMode();
  return (
    <SettingsRow label={LANE_SWITCH.label} description={LANE_SWITCH.description}>
      <Switch checked={hosted} onCheckedChange={(on) => writeLane(on ? "simple" : "full")} aria-label={LANE_SWITCH.label} />
    </SettingsRow>
  );
}
