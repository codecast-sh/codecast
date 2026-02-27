"use client";

import { useState } from "react";
import { copyToClipboard } from "../lib/utils";

const INSTALL_COMMANDS = {
  unix: "curl -fsSL codecast.sh/install | sh",
  windows: 'powershell -c "irm codecast.sh/install.ps1 | iex"',
};

export function InstallTabs() {
  const [platform, setPlatform] = useState<"unix" | "windows">("unix");
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
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
      </div>
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
    </div>
  );
}
