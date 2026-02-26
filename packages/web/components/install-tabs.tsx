"use client";

import { useState } from "react";
import { copyToClipboard } from "../lib/utils";

const INSTALL_COMMANDS = {
  unix: "curl -fsSL codecast.sh/install | sh",
  windows: 'powershell -c "irm codecast.sh/install.ps1 | iex"',
};

export function InstallTabs() {
  const [platform, setPlatform] = useState<"unix" | "windows" | "desktop">("unix");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (platform === "desktop") return;
    await copyToClipboard(INSTALL_COMMANDS[platform]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl overflow-hidden border border-stone-300">
      <div className="flex items-center bg-stone-200">
        <button
          onClick={() => setPlatform("unix")}
          className={`px-5 py-2.5 text-sm font-medium transition-all ${
            platform === "unix"
              ? "bg-stone-800 text-white"
              : "text-stone-500 hover:text-stone-700 hover:bg-stone-300"
          }`}
        >
          Linux & macOS
        </button>
        <button
          onClick={() => setPlatform("windows")}
          className={`px-5 py-2.5 text-sm font-medium transition-all ${
            platform === "windows"
              ? "bg-stone-800 text-white"
              : "text-stone-500 hover:text-stone-700 hover:bg-stone-300"
          }`}
        >
          Windows
        </button>
        <button
          onClick={() => setPlatform("desktop")}
          className={`px-5 py-2.5 text-sm font-medium transition-all ${
            platform === "desktop"
              ? "bg-stone-800 text-white"
              : "text-stone-500 hover:text-stone-700 hover:bg-stone-300"
          }`}
        >
          Desktop App
        </button>
      </div>
      {platform === "desktop" ? (
        <div className="p-4 flex items-center justify-between gap-4 bg-stone-800">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-stone-400" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
            </svg>
            <div className="text-left">
              <span className="text-stone-100 text-sm font-medium">Download for macOS</span>
              <span className="text-stone-500 text-xs ml-2">Apple Silicon</span>
            </div>
          </div>
          <a
            href="https://codecast.sh/download/mac"
            className="px-4 py-1.5 bg-white text-stone-900 rounded-md text-sm font-medium hover:bg-stone-100 transition-colors"
          >
            Download
          </a>
        </div>
      ) : (
        <div className="p-4 flex items-center justify-between gap-4 bg-stone-800">
          <code className="text-stone-100 text-sm font-mono">
            {platform === "unix" ? (
              INSTALL_COMMANDS.unix
            ) : (
              <>
                <span className="text-stone-500">&gt; </span>
                {INSTALL_COMMANDS.windows}
              </>
            )}
          </code>
          <button
            onClick={handleCopy}
            className="p-2 text-stone-400 hover:text-white hover:bg-stone-700 rounded transition-colors"
            title="Copy to clipboard"
          >
            {copied ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
