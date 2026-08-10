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
          className="group p-2 rounded-lg shrink-0 transition-all duration-200 hover:-translate-y-px hover:brightness-110 active:translate-y-0 active:brightness-95"
          style={copied
            ? { backgroundColor: '#859900', color: '#fdf6e3', boxShadow: '0 2px 12px rgba(133,153,0,0.45)' }
            : { background: 'linear-gradient(135deg, #e86c5d 0%, #cb4b16 100%)', color: '#fdf6e3', boxShadow: '0 2px 12px rgba(203,75,22,0.4)' }
          }
          title="Copy to clipboard"
        >
          {copied ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2" className="transition-transform duration-200 group-hover:translate-x-[1.5px] group-hover:translate-y-[1.5px]" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" className="transition-transform duration-200 group-hover:-translate-x-[1.5px] group-hover:-translate-y-[1.5px]" />
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
