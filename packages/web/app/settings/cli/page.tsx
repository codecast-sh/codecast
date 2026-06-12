import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { copyToClipboard } from "../../../lib/utils";
import { AppLoader } from "../../../components/AppLoader";

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

export default function CliSettingsPage() {
  const { isAuthenticated } = useConvexAuth();
  const currentUser = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? {} : "skip"
  );
  const [copied, setCopied] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [os, setOs] = useState<InstallOs>(detectOs);

  const createSetupToken = useMutation(api.apiTokens.createSetupToken);

  const handleCopy = async (text: string, label: string) => {
    await copyToClipboard(text);
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
    <div className="space-y-6">
      <div className="bg-sol-bg-alt/50 rounded-lg p-6 border border-sol-border">
        <h2 className="text-lg font-medium text-sol-text mb-4">Install</h2>
        <p className="text-sol-text-muted text-sm mb-4">
          Run this command on any machine to install and link to your account:
        </p>

        {!setupToken || isTokenExpired ? (
          <button
            onClick={generateSetupToken}
            disabled={isGenerating}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            {isGenerating ? "Generating..." : "Generate Install Command"}
          </button>
        ) : (
          <div className="space-y-3">
            <div className="inline-flex rounded-lg border border-sol-border overflow-hidden text-xs">
              {(["unix", "windows"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setOs(value)}
                  className={`px-3 py-1.5 transition-colors ${
                    os === value
                      ? "bg-amber-600 text-white"
                      : "bg-sol-bg text-sol-text-muted hover:bg-sol-bg-highlight"
                  }`}
                >
                  {value === "unix" ? "macOS / Linux" : "Windows"}
                </button>
              ))}
            </div>
            <p className="text-sol-text-dim text-xs">
              Token expires in 60 minutes:
            </p>
            <div className="relative">
              <code className="block bg-sol-bg rounded-lg p-4 text-sm text-green-400 overflow-x-auto pr-20 break-all">
                {installCommand(os, setupToken)}
              </code>
              <button
                onClick={() => handleCopy(installCommand(os, setupToken), "install")}
                className="absolute top-2 right-2 px-3 py-1.5 bg-sol-bg-highlight hover:bg-amber-600/20 text-sol-text-muted text-xs rounded transition-colors"
              >
                {copied === "install" ? "Copied!" : "Copy"}
              </button>
            </div>
            <button
              onClick={generateSetupToken}
              className="text-sol-text-dim text-xs hover:text-sol-text-muted transition-colors"
            >
              Generate new token
            </button>
          </div>
        )}
      </div>

      <div className="bg-sol-bg-alt/50 rounded-lg p-6 border border-sol-border">
        <h2 className="text-lg font-medium text-sol-text mb-4">CLI Commands</h2>
        <div className="bg-sol-base03 p-3 rounded font-mono text-sm space-y-1">
          <p><span className="text-sol-cyan">cast start</span> <span className="text-sol-base1">- Start the sync daemon</span></p>
          <p><span className="text-sol-cyan">cast stop</span> <span className="text-sol-base1">- Stop the sync daemon</span></p>
          <p><span className="text-sol-cyan">cast status</span> <span className="text-sol-base1">- Check daemon status</span></p>
        </div>
      </div>

    </div>
  );
}
