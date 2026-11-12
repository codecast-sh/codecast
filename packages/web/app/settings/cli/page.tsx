import { Download, Terminal } from "lucide-react";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { BrowserExtensionSetup } from "../../../components/settings/BrowserExtensionSetup";
import { ConnectMachine } from "../../../components/ConnectMachine";

const CLI_COMMANDS = [
  { cmd: "cast start", desc: "Start the sync daemon" },
  { cmd: "cast stop", desc: "Stop the sync daemon" },
  { cmd: "cast status", desc: "Check daemon status" },
];

export default function CliSettingsPage() {
  return (
    <SettingsPanel>
      <SettingsSection
        title="Install"
        icon={Download}
        description="Run on any machine to install cast and connect it, or to bring back one that went offline."
        padded
      >
        <ConnectMachine location="settings_cli" />
      </SettingsSection>

      <BrowserExtensionSetup />

      <SettingsSection title="CLI commands" icon={Terminal} padded>
        <div className="space-y-1 rounded-lg bg-sol-bg p-3 font-mono text-sm">
          {CLI_COMMANDS.map(({ cmd, desc }) => (
            <p key={cmd}>
              <span className="text-sol-cyan">{cmd}</span>{" "}
              <span className="text-sol-text-muted">- {desc}</span>
            </p>
          ))}
        </div>
      </SettingsSection>
    </SettingsPanel>
  );
}
