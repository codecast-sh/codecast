// The mode choice in settings, under Appearance: Everyday is hosted mode
// (ui.lane "simple"), Developer the developer default. The main app follows
// the preference where the person is (lib/surfaces.ts), so the choice only
// writes it.
import { SettingsField, SettingsOptionGroup } from "../settings/ui";
import { useHostedMode } from "../../lib/surfaces";
import { LANE_SWITCH, writeLane } from "./lanePref";

export function LaneSettingRow() {
  const hosted = useHostedMode();
  return (
    <SettingsField label={LANE_SWITCH.modeLabel} hint={hosted ? LANE_SWITCH.everydayHint : LANE_SWITCH.developerHint}>
      <SettingsOptionGroup
        value={hosted ? "simple" : "full"}
        onChange={(value) => writeLane(value === "simple" ? "simple" : "full")}
        label={LANE_SWITCH.modeLabel}
        variant="pill"
        options={[
          { value: "simple", label: LANE_SWITCH.everyday },
          { value: "full", label: LANE_SWITCH.developer },
        ]}
      />
    </SettingsField>
  );
}
