// The Voice section of the settings modal: recognizing my voice in voice
// notes (components/settings/VoiceSettings). Its own section, as on the phone
// (Settings › Voice), so it is found under its own name.
import { SettingsPanel } from "../../../components/settings/ui";
import { VoiceSettings } from "../../../components/settings/VoiceSettings";

export default function VoiceSettingsPage() {
  return (
    <SettingsPanel>
      <VoiceSettings />
    </SettingsPanel>
  );
}
