import { useState, Suspense } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Check, Circle, Github, ListChecks, Mail, TriangleAlert } from "lucide-react";
import { AppLoader } from "../../../components/AppLoader";
import { useCodecastSignOut } from "../../../hooks/useCodecastSignOut";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";

const GITHUB_FEATURES = [
  "View and sync pull requests",
  "Code review with inline comments",
  "Sync team members from GitHub org",
  "Link AI sessions to commits and PRs",
  "Sync commit history with diffs",
];

function AccountsContent() {
  const user = useQuery(api.users.getCurrentUser);
  const unlinkGitHub = useMutation(api.users.unlinkGitHub);
  const deleteAccount = useMutation(api.users.deleteAccount);
  const signOut = useCodecastSignOut();
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();

  useWatchEffect(() => {
    const urlError = searchParams.get("error");
    if (urlError) {
      setError(urlError);
      // Consume the param off the CURRENT URL — this panel renders inside the
      // settings modal over whatever page carried the OAuth return.
      const next = new URLSearchParams(searchParams.toString());
      next.delete("error");
      const q = next.toString();
      router.replace(`${window.location.pathname}${q ? `?${q}` : ""}`, { scroll: false });
    }
  }, [searchParams, router]);

  if (!user) {
    return null;
  }

  const handleConnectGitHub = () => {
    router.push("/settings/accounts/link-github");
  };

  const handleDisconnectGitHub = async () => {
    setIsUnlinking(true);
    setError("");
    try {
      await unlinkGitHub({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect GitHub");
    } finally {
      setIsUnlinking(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== "DELETE") {
      setError("Please type DELETE to confirm");
      return;
    }
    setIsDeleting(true);
    setError("");
    try {
      const result = await deleteAccount({});
      if (result.completed) {
        await signOut();
        router.push("/");
      } else {
        setError(result.message);
        setShowDeleteConfirm(false);
        setDeleteConfirmText("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete account");
    } finally {
      setIsDeleting(false);
    }
  };

  const hasGitHub = !!user.github_id;
  const hasEmail = !!user.email;

  return (
    <SettingsPanel>
      {error && (
        <div className="rounded-lg border border-sol-red/20 bg-sol-red/10 p-3 text-sm text-sol-red">
          {error}
        </div>
      )}

      <SettingsSection
        title="Connected accounts"
        icon={Github}
        description="GitHub powers code features; email is how you sign in and how we reach you."
      >
        <SettingsRow
          icon={Github}
          label="GitHub"
          description={
            hasGitHub ? (
              <span className="inline-flex items-center gap-1 text-sol-green">
                <Check className="h-3.5 w-3.5" />
                Connected as @{user.github_username}
              </span>
            ) : (
              "Not connected"
            )
          }
        >
          {hasGitHub ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleConnectGitHub}
                className="text-sol-cyan border-sol-cyan/30 hover:bg-sol-cyan/10"
                title="Re-authorize to update permissions"
              >
                Reconfigure
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnectGitHub}
                disabled={isUnlinking || !hasEmail}
                className="text-sol-orange border-sol-orange/30 hover:bg-sol-orange/10"
                title={!hasEmail ? "Add email/password login before disconnecting GitHub" : undefined}
              >
                {isUnlinking ? "Disconnecting..." : "Disconnect"}
              </Button>
            </>
          ) : (
            // GitHub's brand black, kept on purpose.
            <Button size="sm" onClick={handleConnectGitHub} className="bg-[#24292e] hover:bg-[#1a1e22] text-white">
              Connect
            </Button>
          )}
        </SettingsRow>

        <SettingsRow
          icon={Mail}
          label="Email"
          description={
            hasEmail ? (
              <span className="inline-flex items-center gap-1 text-sol-green">
                <Check className="h-3.5 w-3.5" />
                {user.email}
              </span>
            ) : (
              "Not configured"
            )
          }
        >
          {hasEmail ? "Primary" : "Not set"}
        </SettingsRow>

        {hasGitHub && !hasEmail && (
          <div className="px-4 py-3 text-sm text-sol-orange sm:px-5">
            Add an email and password to enable disconnecting GitHub in the future.
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="GitHub features"
        icon={ListChecks}
        description="Connecting GitHub enables these features:"
        padded
      >
        <ul className="space-y-2 text-sm text-sol-text">
          {GITHUB_FEATURES.map((feature) => (
            <li key={feature} className="flex items-center gap-2">
              {hasGitHub ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-sol-green" />
              ) : (
                <Circle className="h-3 w-3 shrink-0 text-sol-text-dim" />
              )}
              {feature}
            </li>
          ))}
        </ul>
        {hasGitHub && (
          <p className="mt-4 text-xs text-sol-text-dim">
            Use &ldquo;Reconfigure&rdquo; to update GitHub permissions if you need access to additional repositories or organizations.
          </p>
        )}
      </SettingsSection>

      <SettingsSection title={<span className="text-sol-red">Danger zone</span>} icon={TriangleAlert}>
        {!showDeleteConfirm ? (
          <SettingsRow
            label="Delete account"
            description="Permanently delete your account and all associated data. This action cannot be undone."
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowDeleteConfirm(true)}
              className="text-sol-red border-sol-red/30 hover:bg-sol-red/10"
            >
              Delete account
            </Button>
          </SettingsRow>
        ) : (
          <div className="space-y-4 px-4 py-4 sm:px-5">
            <div className="rounded-lg border border-sol-red/30 bg-sol-red/10 p-4">
              <p className="mb-2 text-sm font-medium text-sol-red">This will permanently delete:</p>
              <ul className="list-inside list-disc space-y-1 text-sm text-sol-red/80">
                <li>All your conversations and messages</li>
                <li>All bookmarks and saved patterns</li>
                <li>All API tokens and integrations</li>
                <li>Your account and profile</li>
              </ul>
            </div>
            <div>
              <label htmlFor="delete-confirm" className="mb-2 block text-sm text-sol-text-muted">
                Type <span className="font-mono text-sol-red">DELETE</span> to confirm:
              </label>
              <Input
                id="delete-confirm"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                className="bg-sol-bg border-sol-border text-sol-text focus-visible:ring-sol-red"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText("");
                }}
                className="text-sol-text border-sol-border"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDeleteAccount}
                disabled={isDeleting || deleteConfirmText !== "DELETE"}
              >
                {isDeleting ? "Deleting..." : "Permanently delete account"}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </SettingsPanel>
  );
}

export default function AccountsPage() {
  return (
    <Suspense fallback={<AppLoader className="min-h-0 bg-transparent py-12" size={28} />}>
      <AccountsContent />
    </Suspense>
  );
}
