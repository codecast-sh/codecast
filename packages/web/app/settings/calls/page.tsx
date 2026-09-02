// The Calls section of the settings modal: the same body the people window
// opens as a sheet (components/calls/CallSettings), so "call settings" is one
// thing whichever door a person came through.
import { CallSettings } from "../../../components/calls/CallSettings";
import { SettingsPanel } from "../../../components/settings/ui";

export default function CallsSettingsPage() {
  return (
    <SettingsPanel>
      <CallSettings />
    </SettingsPanel>
  );
}
