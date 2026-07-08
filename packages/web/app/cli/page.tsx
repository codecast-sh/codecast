import { SettingsRedirect } from "../../components/settings/SettingsRedirect";

export default function CliPage() {
  return <SettingsRedirect hit={{ section: "cli", search: "" }} />;
}
