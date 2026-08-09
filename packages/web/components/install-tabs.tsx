import { useState } from "react";
import { copyToClipboard } from "../lib/utils";
import { track } from "../lib/analytics";

const INSTALL_COMMANDS = {
  unix: "curl -fsSL codecast.sh/install | sh",
  windows: 'powershell -c "irm codecast.sh/install.ps1 | iex"',
};

export function InstallTabs({ location = "unknown", showAlternatives = true }: { location?: string; showAlternatives?: boolean }) {
  const [platform, setPlatform] = useState<"unix" | "windows">("unix");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyToClipboard(INSTALL_COMMANDS[platform]);
    track("install_command_copied", { location, platform, with_token: false });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #586e75' }}>
      <div className="flex items-center" style={{ backgroundColor: '#eee8d5' }}>
        <button
          onClick={() => setPlatform("unix")}
          className="px-5 py-2.5 text-sm font-medium transition-all"
          style={platform === "unix"
            ? { backgroundColor: '#002b36', color: '#fdf6e3' }
            : { color: '#657b83' }
          }
        >
          Linux & macOS
        </button>
        <button
          onClick={() => setPlatform("windows")}
          className="px-5 py-2.5 text-sm font-medium transition-all"
          style={platform === "windows"
            ? { backgroundColor: '#002b36', color: '#fdf6e3' }
            : { color: '#657b83' }
          }
        >
          Windows
        </button>
        <a
          href={platform === "unix" ? "https://codecast.sh/install" : "https://codecast.sh/install.ps1"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => track("install_script_viewed", { location, platform })}
          className="ml-auto px-5 py-2.5 text-sm font-medium transition-colors hover:text-[#002b36]"
          style={{ color: '#93a1a1' }}
        >
          View install script
        </a>
      </div>
      <div className="p-4 flex items-center justify-between gap-4" style={{ backgroundColor: '#002b36' }}>
        <code className="text-sm font-mono" style={{ color: '#eee8d5' }}>
          {platform === "unix" ? (
            INSTALL_COMMANDS.unix
          ) : (
            <>
              <span style={{ color: '#586e75' }}>&gt; </span>
              {INSTALL_COMMANDS.windows}
            </>
          )}
        </code>
        <button
          onClick={handleCopy}
          className="p-2 rounded-md transition-colors shrink-0"
          style={copied
            ? { backgroundColor: '#859900', color: '#002b36' }
            : { backgroundColor: '#b58900', color: '#002b36' }
          }
          title="Copy to clipboard"
        >
          {copied ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      </div>
      {showAlternatives && platform === "unix" && (
        <div className="px-4 pb-3 text-xs" style={{ backgroundColor: '#002b36', color: '#586e75' }}>
          Also via <code>brew install codecast-sh/tap/codecast</code> or <code>npm install -g @codecast-sh/cli</code>
        </div>
      )}
      {platform === "windows" && (
        <div className="px-4 pb-3 text-xs" style={{ backgroundColor: '#002b36', color: '#586e75' }}>
          Runs in PowerShell. Installs codecast into WSL (Windows Subsystem for Linux) and sets WSL up first if needed.
        </div>
      )}
    </div>
  );
}
