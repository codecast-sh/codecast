import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { BookMarked, Github, Info } from "lucide-react";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { Button } from "../../../../components/ui/button";
import { SettingsPanel, SettingsRow, SettingsSection } from "../../../../components/settings/ui";

export default function GitHubAppPage() {
  const user = useQuery(api.users.getCurrentUser);
  const installations = useQuery(
    api.githubApp.listInstallations,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );
  const deleteInstallation = useMutation(api.githubApp.deleteInstallation);

  const searchParams = useSearchParams();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  useWatchEffect(() => {
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
    const appSlug = import.meta.env.VITE_GITHUB_APP_SLUG || "codecast-sh";
    const installUrl = `https://github.com/apps/${appSlug}/installations/new?state=${state}`;
    window.location.href = installUrl;
  };

  const handleDelete = async (installationId: string) => {
    await deleteInstallation({ installation_id: installationId as any });
    setConfirmRemove(null);
    toast.success("GitHub App installation removed.");
  };

  if (!user) {
    return null;
  }

  return (
    <SettingsPanel>
      {message && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            message.type === "success"
              ? "border-sol-green/20 bg-sol-green/10 text-sol-green"
              : "border-sol-red/20 bg-sol-red/10 text-sol-red"
          }`}
        >
          {message.text}
        </div>
      )}

      <SettingsSection
        title="GitHub App"
        icon={Github}
        description="Install the Codecast GitHub App to automatically receive PR webhooks for all repositories where it's installed. This replaces the need to set up individual webhook configurations."
      >
        {!user.team_id && (
          <div className="px-4 py-3 text-sm text-sol-yellow sm:px-5">
            You need to be part of a team to install the GitHub App. Create or join a team in the
            Team settings first.
          </div>
        )}
        <SettingsRow
          label="Install"
          description="Add the app to a GitHub account or organization and pick which repositories it can see."
        >
          <Button
            size="sm"
            onClick={handleInstall}
            disabled={!user.team_id}
            variant="cyan"
          >
            Install GitHub App
          </Button>
        </SettingsRow>
      </SettingsSection>

      {installations && installations.length > 0 && (
        <SettingsSection title="Installed accounts" icon={Github}>
          {installations.map((installation) => (
            <SettingsRow
              key={installation._id}
              label={
                <span className="flex items-center gap-2">
                  {installation.account_login}
                  <span className="rounded bg-sol-bg-highlight px-1.5 py-0.5 text-[10px] text-sol-text-muted">
                    {installation.account_type}
                  </span>
                </span>
              }
              description={
                <>
                  {installation.repository_selection === "all"
                    ? "All repositories"
                    : `${installation.repositories?.length || 0} repositories`}
                  {installation.suspended_at && <span className="ml-2 text-sol-yellow">(suspended)</span>}
                </>
              }
            >
              {confirmRemove === installation._id ? (
                <>
                  <span className="text-xs text-sol-text-dim">Remove this installation?</span>
                  <Button variant="destructive" size="sm" onClick={() => handleDelete(installation._id)}>
                    Remove
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <a
                    href={`https://github.com/settings/installations/${installation.installation_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2 text-sm text-sol-cyan hover:text-sol-cyan/80"
                  >
                    Configure
                  </a>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmRemove(installation._id)}
                    className="text-sol-red border-sol-red/30 hover:bg-sol-red/10"
                    title="Webhooks will no longer be received for these repositories"
                  >
                    Remove
                  </Button>
                </>
              )}
            </SettingsRow>
          ))}
        </SettingsSection>
      )}

      {installations && installations.length > 0 && (
        <SettingsSection title="Selected repositories" icon={BookMarked} padded>
          <div className="space-y-2">
            {installations
              .filter((i) => i.repository_selection === "selected" && i.repositories)
              .flatMap((i) => i.repositories || [])
              .map((repo) => (
                <div key={repo.id} className="flex items-center gap-2">
                  <BookMarked className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
                  <span className="font-mono text-sm text-sol-text">{repo.full_name}</span>
                </div>
              ))}
            {installations.every((i) => i.repository_selection === "all") && (
              <p className="text-sm text-sol-text-muted">
                All installations have access to all repositories. No specific repository list available.
              </p>
            )}
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="How it works" icon={Info} padded>
        <div className="space-y-3 text-sm text-sol-text-secondary">
          <p>
            Once installed, GitHub tells Codecast about every PR, comment, and review in the
            repositories you picked — no per-repository setup. Codecast uses that to link sessions
            to pull requests and keep comments in sync both ways. Actions you take yourself, like
            opening a PR, still go through your own GitHub sign-in.
          </p>
          <p>
            <strong className="text-sol-text">What the app can see and do:</strong>
          </p>
          <ul className="ml-2 list-inside list-disc space-y-1">
            <li>Read file contents — to show PR diffs</li>
            <li>Read and write pull requests — to post review comments</li>
            <li>Read and write issues — to reply in PR conversations</li>
            <li>Read metadata — to list the repositories it&apos;s installed on</li>
          </ul>
        </div>
      </SettingsSection>
    </SettingsPanel>
  );
}
