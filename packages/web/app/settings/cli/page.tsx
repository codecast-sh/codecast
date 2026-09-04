import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState } from "react";
import { Download, Terminal } from "lucide-react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { copyToClipboard } from "../../../lib/utils";
import { track } from "../../../lib/analytics";
import { AppLoader } from "../../../components/AppLoader";
import { Button } from "../../../components/ui/button";
import { SegmentedToggle } from "../../../components/SegmentedToggle";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";

type InstallOs = "unix" | "windows";

function detectOs(): InstallOs {
  if (typeof navigator === "undefined") return "unix";
  const ua = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  return /win/i.test(ua) ? "windows" : "unix";
}

// The two install commands diverge by shell: curl|sh can't run on Windows, and
// irm|iex can't run on a POSIX shell. The Windows form passes the token via env
// var because `irm | iex` evaluates script text and can't forward arguments.
function installCommand(os: InstallOs, token: string): string {
  return os === "windows"
    ? `$env:CODECAST_SETUP_TOKEN="${token}"; irm codecast.sh/install.ps1 | iex`
    : `curl -fsSL codecast.sh/install | sh -s -- ${token}`;
}

const CLI_COMMANDS = [
  { cmd: "cast start", desc: "Start the sync daemon" },
  { cmd: "cast stop", desc: "Stop the sync daemon" },
  { cmd: "cast status", desc: "Check daemon status" },
];

export default function CliSettingsPage() {
  const { user: currentUser } = useCurrentUser();
  const [copied, setCopied] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [os, setOs] = useState<InstallOs>(detectOs);

  const createSetupToken = useMutation(api.apiTokens.createSetupToken);

  const handleCopy = async (text: string, label: string) => {
    await copyToClipboard(text);
    if (label === "install") {
      track("install_command_copied", { location: "settings_cli", platform: os, with_token: true });
    }
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  const generateSetupToken = async () => {
    setIsGenerating(true);
    try {
      const result = await createSetupToken({});
      setSetupToken(result.token);
      setTokenExpiry(result.expiresAt);
    } finally {
      setIsGenerating(false);
    }
  };

  const [now, setNow] = useState(Date.now());
  useWatchEffect(() => {
    if (!tokenExpiry) return;
    const remaining = tokenExpiry - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 100);
    return () => clearTimeout(timer);
  }, [tokenExpiry]);
  const isTokenExpired = tokenExpiry ? now > tokenExpiry : false;

  if (!currentUser) {
    return <AppLoader className="min-h-0 bg-transparent py-12" size={28} />;
  }

  return (
    <SettingsPanel>
      <SettingsSection
        title="Install"
        icon={Download}
        description="Run this command on any machine to install and link to your account."
        padded
      >
        {!setupToken || isTokenExpired ? (
          <Button
            size="sm"
            onClick={generateSetupToken}
            disabled={isGenerating}
            variant="cyan"
          >
            {isGenerating ? "Generating..." : "Generate install command"}
          </Button>
        ) : (
          <div className="space-y-3">
            <SegmentedToggle
              value={os}
              onChange={(key) => setOs(key as InstallOs)}
              items={[
                { key: "unix", label: "macOS / Linux" },
                { key: "windows", label: "Windows" },
              ]}
            />
            <p className="text-xs text-sol-text-dim">Token expires in 60 minutes:</p>
            {os === "windows" && (
              <p className="text-xs text-sol-text-dim">
                Runs in PowerShell. Installs codecast into WSL (Windows Subsystem for Linux) and sets WSL up first if needed.
              </p>
            )}
            <div className="relative">
              <code className="block overflow-x-auto break-all rounded-lg bg-sol-bg p-4 pr-20 text-sm text-sol-green">
                {installCommand(os, setupToken)}
              </code>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleCopy(installCommand(os, setupToken), "install")}
                className="absolute right-2 top-2 h-7 px-2.5 text-xs"
              >
                {copied === "install" ? "Copied!" : "Copy"}
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={generateSetupToken}
              className="h-6 px-1 text-xs text-sol-text-dim hover:text-sol-text-muted"
            >
              Generate new token
            </Button>
          </div>
        )}
      </SettingsSection>

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
