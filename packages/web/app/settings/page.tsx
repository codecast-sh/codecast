import { SettingsRedirect } from "../../components/settings/SettingsRedirect";
import { DEFAULT_SETTINGS_SECTION } from "../../lib/settingsSections";

// Normally unreachable — SettingsLayout intercepts /settings before the
// Outlet renders. Kept as a safety net for direct mounts.
export default function SettingsPage() {
  return <SettingsRedirect hit={{ section: DEFAULT_SETTINGS_SECTION, search: "" }} />;
}
