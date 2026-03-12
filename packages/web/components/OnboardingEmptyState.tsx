"use client";

import { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { copyToClipboard } from "../lib/utils";

export function OnboardingEmptyState() {
  const [copied, setCopied] = useState(false);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [tokenExpiry, setTokenExpiry] = useState<number | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const createSetupToken = useMutation(api.apiTokens.createSetupToken);

  const handleCopy = async (text: string) => {
    await copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
  useEffect(() => {
    if (!tokenExpiry) return;
    const remaining = tokenExpiry - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 100);
    return () => clearTimeout(timer);
  }, [tokenExpiry]);
  const isTokenExpired = tokenExpiry ? now > tokenExpiry : false;

  return (
    <div className="flex flex-col items-center justify-center py-12 px-4">
      <div className="w-16 h-16 bg-amber-500/20 rounded-full flex items-center justify-center mb-6">
        <svg
          className="w-8 h-8 text-amber-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
          />
        </svg>
      </div>

      <h2 className="text-2xl font-semibold text-sol-text mb-3">
        Install the CLI
      </h2>
      <p className="text-sol-text-muted text-center max-w-md mb-8">
        Run this command in your terminal to install codecast and start syncing your sessions.
      </p>

      <div className="w-full max-w-lg">
        {!setupToken || isTokenExpired ? (
          <button
            onClick={generateSetupToken}
            disabled={isGenerating}
            className="w-full px-6 py-4 bg-amber-600 hover:bg-amber-500 text-white text-lg font-medium rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isGenerating ? (
              <>
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Generating...
              </>
            ) : (
              "Generate Install Command"
            )}
          </button>
        ) : (
          <div className="space-y-4">
            <p className="text-sol-text-dim text-sm text-center">
              Token expires in 60 minutes
            </p>
            <div className="relative">
              <code className="block bg-sol-bg rounded-xl p-5 text-sm text-green-400 overflow-x-auto pr-24 break-all font-mono">
                curl -fsSL codecast.sh/install | sh -s -- {setupToken}
              </code>
              <button
                onClick={() =>
                  handleCopy(`curl -fsSL codecast.sh/install | sh -s -- ${setupToken}`)
                }
                className="absolute top-3 right-3 px-4 py-2 bg-sol-bg-highlight hover:bg-amber-600/30 text-sol-text-muted hover:text-amber-400 text-sm rounded-lg transition-colors"
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <button
              onClick={generateSetupToken}
              className="w-full text-sol-text-dim text-sm hover:text-sol-text-muted transition-colors py-2"
            >
              Generate new token
            </button>
          </div>
        )}
      </div>

      <div className="mt-10 pt-8 border-t border-sol-border/30 w-full max-w-lg">
        <h3 className="text-sm font-medium text-sol-text-muted mb-4 text-center">
          After installing
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
          <div className="p-4 rounded-lg bg-sol-bg-alt/30">
            <code className="text-green-400 text-sm">cast start</code>
            <p className="text-sol-text-dim text-xs mt-2">Start syncing</p>
          </div>
          <div className="p-4 rounded-lg bg-sol-bg-alt/30">
            <code className="text-green-400 text-sm">cast status</code>
            <p className="text-sol-text-dim text-xs mt-2">Check status</p>
          </div>
          <div className="p-4 rounded-lg bg-sol-bg-alt/30">
            <code className="text-green-400 text-sm">cast stop</code>
            <p className="text-sol-text-dim text-xs mt-2">Stop syncing</p>
          </div>
        </div>
      </div>
    </div>
  );
}
