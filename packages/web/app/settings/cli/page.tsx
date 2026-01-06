"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useState } from "react";
import { copyToClipboard } from "../../../lib/utils";

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

  const isTokenExpired = tokenExpiry ? Date.now() > tokenExpiry : false;

  if (!currentUser) {
    return (
      <div className="bg-sol-bg-alt/50 rounded-lg p-6 border border-sol-border">
        <p className="text-sol-text-muted">Loading...</p>
      </div>
    );
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
            <p className="text-sol-text-dim text-xs">
              Token expires in 5 minutes:
            </p>
            <div className="relative">
              <code className="block bg-sol-bg rounded-lg p-4 text-sm text-green-400 overflow-x-auto pr-20 break-all">
                curl -fsSL codecast.sh/install | sh -s -- {setupToken}
              </code>
              <button
                onClick={() =>
                  handleCopy(
                    `curl -fsSL codecast.sh/install | sh -s -- ${setupToken}`,
                    "install"
                  )
                }
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
        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-3">
            <code className="bg-sol-bg px-3 py-1.5 rounded text-green-400 whitespace-nowrap">
              codecast start
            </code>
            <span className="text-sol-text-muted pt-1">
              Start the sync daemon
            </span>
          </div>
          <div className="flex items-start gap-3">
            <code className="bg-sol-bg px-3 py-1.5 rounded text-green-400 whitespace-nowrap">
              codecast stop
            </code>
            <span className="text-sol-text-muted pt-1">
              Stop the sync daemon
            </span>
          </div>
          <div className="flex items-start gap-3">
            <code className="bg-sol-bg px-3 py-1.5 rounded text-green-400 whitespace-nowrap">
              codecast status
            </code>
            <span className="text-sol-text-muted pt-1">Check daemon status</span>
          </div>
        </div>
      </div>
    </div>
  );
}
