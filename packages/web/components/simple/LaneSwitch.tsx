// The lane switch in settings: on puts the person in the simple lane (the
// hosted assistant's calm home), off returns them to the full app. The lane
// itself carries the way back in its own menu (SimpleShell's LaneMenu).
import { Switch } from "../ui/switch";
import { SettingsRow } from "../settings/ui";
import { useInboxStore } from "../../store/inboxStore";
import { laneOf, useSetLane } from "./lanePref";

export function LaneSettingRow() {
  const simple = useInboxStore((s) => laneOf(s.clientState?.ui) === "simple");
  const setLane = useSetLane();
  return (
    <SettingsRow
      label="Assistant view"
      description="A calm home for asking your assistant to handle email, calendar and errands, with no code, terminals or machines in sight"
    >
      <Switch checked={simple} onCheckedChange={(on) => setLane(on ? "simple" : "full")} aria-label="Assistant view" />
    </SettingsRow>
  );
}
