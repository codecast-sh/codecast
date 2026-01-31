"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../../components/ui/card";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

export default function GitHubAppPage() {
  const user = useQuery(api.users.getCurrentUser);
  const installations = useQuery(
    api.githubApp.listInstallations,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );
  const deleteInstallation = useMutation(api.githubApp.deleteInstallation);

  const searchParams = useSearchParams();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (searchParams.get("success") === "true") {
      setMessage({ type: "success", text: "GitHub App installed successfully!" });
    } else if (searchParams.get("error") === "missing_team") {
      setMessage({ type: "error", text: "You must be part of a team to install the GitHub App." });
    } else if (searchParams.get("error") === "installation_failed") {
      setMessage({ type: "error", text: "Failed to install the GitHub App. Please try again." });
    }
  }, [searchParams]);

  const handleInstall = () => {
    if (!user?.team_id) {
      setMessage({ type: "error", text: "You must be part of a team to install the GitHub App." });
      return;
    }

    const state = btoa(JSON.stringify({ team_id: user.team_id, user_id: user._id }));
    const appSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || "codecast-sh";
    const installUrl = `https://github.com/apps/${appSlug}/installations/new?state=${state}`;
    window.location.href = installUrl;
  };

  const handleDelete = async (installationId: string) => {
    if (!confirm("Are you sure you want to remove this GitHub App installation? Webhooks will no longer be received for these repositories.")) {
      return;
    }
    await deleteInstallation({ installation_id: installationId as any });
    setMessage({ type: "success", text: "GitHub App installation removed." });
  };

  if (!user) {
    return null;
  }

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`p-4 rounded border ${
            message.type === "success"
              ? "bg-sol-green/10 border-sol-green text-sol-green"
              : "bg-sol-red/10 border-sol-red text-sol-red"
          }`}
        >
          {message.text}
        </div>
      )}

      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">GitHub App</h2>
        <p className="text-sm text-sol-base1 mb-6">
          Install the Codecast GitHub App to automatically receive PR webhooks for all repositories
          where it&apos;s installed. This replaces the need to set up individual webhook configurations.
        </p>

        {!user.team_id && (
          <div className="p-4 bg-sol-yellow/10 border border-sol-yellow rounded mb-6">
            <p className="text-sm text-sol-yellow">
              You need to be part of a team to install the GitHub App.
              Create or join a team in the Team settings first.
            </p>
          </div>
        )}

        <button
          onClick={handleInstall}
          disabled={!user.team_id}
          className={`px-4 py-2 rounded font-medium ${
            user.team_id
              ? "bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90"
              : "bg-sol-base02 text-sol-base1 cursor-not-allowed"
          }`}
        >
          Install GitHub App
        </button>
      </Card>

      {installations && installations.length > 0 && (
        <Card className="p-6 bg-sol-bg border-sol-border">
          <h2 className="text-lg font-semibold text-sol-text mb-4">Installed Accounts</h2>
          <div className="space-y-3">
            {installations.map((installation) => (
              <div
                key={installation._id}
                className="flex items-center justify-between p-4 bg-sol-base2 dark:bg-sol-base02 rounded border border-sol-border"
              >
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-sol-base3 dark:bg-sol-base03 flex items-center justify-center">
                    <span className="text-sol-text font-medium">
                      {installation.account_login[0].toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sol-text font-medium">{installation.account_login}</span>
                      <span className="text-xs px-2 py-0.5 bg-sol-base3 dark:bg-sol-base03 rounded text-sol-base1">
                        {installation.account_type}
                      </span>
                    </div>
                    <div className="text-sm text-sol-base1">
                      {installation.repository_selection === "all" ? (
                        "All repositories"
                      ) : (
                        `${installation.repositories?.length || 0} repositories`
                      )}
                      {installation.suspended_at && (
                        <span className="ml-2 text-sol-yellow">(suspended)</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <a
                    href={`https://github.com/settings/installations/${installation.installation_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3 py-1.5 text-sm text-sol-cyan hover:text-sol-cyan/80"
                  >
                    Configure
                  </a>
                  <button
                    onClick={() => handleDelete(installation._id)}
                    className="px-3 py-1.5 text-sm text-sol-red hover:text-sol-red/80"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {installations && installations.length > 0 && (
        <Card className="p-6 bg-sol-bg border-sol-border">
          <h2 className="text-lg font-semibold text-sol-text mb-4">Selected Repositories</h2>
          <div className="space-y-2">
            {installations
              .filter((i) => i.repository_selection === "selected" && i.repositories)
              .flatMap((i) => i.repositories || [])
              .map((repo) => (
                <div
                  key={repo.id}
                  className="flex items-center gap-2 py-2 px-3 bg-sol-base2 dark:bg-sol-base02 rounded border border-sol-border"
                >
                  <svg
                    className="w-4 h-4 text-sol-base1"
                    fill="currentColor"
                    viewBox="0 0 16 16"
                  >
                    <path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z" />
                  </svg>
                  <span className="text-sm text-sol-text font-mono">{repo.full_name}</span>
                </div>
              ))}
            {installations.every((i) => i.repository_selection === "all") && (
              <p className="text-sm text-sol-base1">
                All installations have access to all repositories. No specific repository list available.
              </p>
            )}
          </div>
        </Card>
      )}

      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">How it Works</h2>
        <div className="text-sm text-sol-base1 space-y-3">
          <p>
            The GitHub App receives webhooks for PRs, comments, and reviews from all repositories where it&apos;s installed.
            This enables automatic linking of Codecast sessions to pull requests.
          </p>
          <p>
            <strong className="text-sol-text">Benefits:</strong>
          </p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>No per-repository webhook configuration needed</li>
            <li>Automatic PR and session linking</li>
            <li>Comment sync between Codecast and GitHub</li>
            <li>Works alongside existing GitHub OAuth for user actions</li>
          </ul>
          <p>
            <strong className="text-sol-text">Permissions requested:</strong>
          </p>
          <ul className="list-disc list-inside space-y-1 ml-2">
            <li>Contents: Read - to view PR diffs</li>
            <li>Pull requests: Read & Write - to post comments</li>
            <li>Issues: Read & Write - for PR comments</li>
            <li>Metadata: Read - to list repositories</li>
          </ul>
        </div>
      </Card>
    </div>
  );
}
