"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { useState } from "react";

export default function CliPage() {
  const { isAuthenticated } = useConvexAuth();
  const currentUser = useQuery(
    api.users.getCurrentUser,
    isAuthenticated ? {} : "skip"
  );
  const [copied, setCopied] = useState<string | null>(null);

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL || "";
  const userId = currentUser?._id || "";

  const configJson = JSON.stringify(
    {
      user_id: userId,
      convex_url: convexUrl,
    },
    null,
    2
  );

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold text-white mb-2">
            CLI Setup
          </h1>
          <p className="text-slate-400 mb-8">
            Connect the codecast daemon to your account.
          </p>

          {!currentUser ? (
            <div className="bg-slate-800/50 rounded-lg p-6 border border-slate-700">
              <p className="text-slate-400">Loading...</p>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="bg-slate-800/50 rounded-lg p-6 border border-slate-700">
                <h2 className="text-lg font-medium text-white mb-4">
                  Quick Setup
                </h2>
                <p className="text-slate-400 text-sm mb-4">
                  Copy this configuration to{" "}
                  <code className="bg-slate-900 px-2 py-0.5 rounded text-blue-400">
                    ~/.codecast/config.json
                  </code>
                </p>
                <div className="relative">
                  <pre className="bg-slate-900 rounded-lg p-4 text-sm text-slate-300 overflow-x-auto">
                    {configJson}
                  </pre>
                  <button
                    onClick={() => copyToClipboard(configJson, "config")}
                    className="absolute top-2 right-2 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded transition-colors"
                  >
                    {copied === "config" ? "Copied!" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="bg-slate-800/50 rounded-lg p-6 border border-slate-700">
                <h2 className="text-lg font-medium text-white mb-4">
                  Manual Setup
                </h2>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                      User ID
                    </label>
                    <div className="flex gap-2">
                      <code className="flex-1 bg-slate-900 px-4 py-2 rounded-lg text-blue-400 text-sm">
                        {userId || "Loading..."}
                      </code>
                      <button
                        onClick={() => copyToClipboard(userId, "userId")}
                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors"
                      >
                        {copied === "userId" ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-2">
                      Convex URL
                    </label>
                    <div className="flex gap-2">
                      <code className="flex-1 bg-slate-900 px-4 py-2 rounded-lg text-blue-400 text-sm truncate">
                        {convexUrl || "Not configured"}
                      </code>
                      <button
                        onClick={() => copyToClipboard(convexUrl, "convexUrl")}
                        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm rounded-lg transition-colors"
                      >
                        {copied === "convexUrl" ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-slate-800/50 rounded-lg p-6 border border-slate-700">
                <h2 className="text-lg font-medium text-white mb-4">
                  CLI Commands
                </h2>
                <div className="space-y-3 text-sm">
                  <div className="flex items-start gap-3">
                    <code className="bg-slate-900 px-3 py-1.5 rounded text-green-400 whitespace-nowrap">
                      codecast start
                    </code>
                    <span className="text-slate-400 pt-1">
                      Start the sync daemon
                    </span>
                  </div>
                  <div className="flex items-start gap-3">
                    <code className="bg-slate-900 px-3 py-1.5 rounded text-green-400 whitespace-nowrap">
                      codecast stop
                    </code>
                    <span className="text-slate-400 pt-1">
                      Stop the sync daemon
                    </span>
                  </div>
                  <div className="flex items-start gap-3">
                    <code className="bg-slate-900 px-3 py-1.5 rounded text-green-400 whitespace-nowrap">
                      codecast status
                    </code>
                    <span className="text-slate-400 pt-1">
                      Check daemon status
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
