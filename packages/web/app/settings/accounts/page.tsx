import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";

function AccountsContent() {
  const user = useQuery(api.users.getCurrentUser);
  const unlinkGitHub = useMutation(api.users.unlinkGitHub);
  const deleteAccount = useMutation(api.users.deleteAccount);
  const { signOut } = useAuthActions();
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const urlError = searchParams.get("error");
    if (urlError) {
      setError(urlError);
      router.replace("/settings/accounts", { scroll: false });
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
    <div className="space-y-6">
      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">Connected Accounts</h2>
        <p className="text-sm text-sol-base1 mb-6">
          Link external accounts to enable additional features like GitHub integration for PRs and code review.
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-sol-bg-alt rounded-lg border border-sol-border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#24292e] rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" clipRule="evenodd" />
                </svg>
              </div>
              <div>
                <div className="font-medium text-sol-text">GitHub</div>
                {hasGitHub ? (
                  <div className="text-sm text-sol-green flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Connected as @{user.github_username}
                  </div>
                ) : (
                  <div className="text-sm text-sol-base1">Not connected</div>
                )}
              </div>
            </div>
            <div className="flex gap-2">
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
                <Button
                  onClick={handleConnectGitHub}
                  className="bg-[#24292e] hover:bg-[#1a1e22] text-white"
                >
                  Connect
                </Button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between p-4 bg-sol-bg-alt rounded-lg border border-sol-border">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-sol-base02 rounded-lg flex items-center justify-center">
                <svg className="w-6 h-6 text-sol-text" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <div className="font-medium text-sol-text">Email</div>
                {hasEmail ? (
                  <div className="text-sm text-sol-green flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {user.email}
                  </div>
                ) : (
                  <div className="text-sm text-sol-base1">Not configured</div>
                )}
              </div>
            </div>
            <div className="text-sm text-sol-base01">
              {hasEmail ? "Primary" : "Add via signup"}
            </div>
          </div>
        </div>

        {hasGitHub && !hasEmail && (
          <div className="mt-4 p-3 bg-sol-orange/10 border border-sol-orange/20 rounded-lg text-sol-orange text-sm">
            Add an email and password to enable disconnecting GitHub in the future.
          </div>
        )}
      </Card>

      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">GitHub Features</h2>
        <p className="text-sm text-sol-base1 mb-4">
          Connecting GitHub enables these features:
        </p>
        <ul className="space-y-2 text-sm text-sol-text">
          <li className="flex items-center gap-2">
            <span className={hasGitHub ? "text-sol-green" : "text-sol-base01"}>
              {hasGitHub ? "✓" : "○"}
            </span>
            View and sync pull requests
          </li>
          <li className="flex items-center gap-2">
            <span className={hasGitHub ? "text-sol-green" : "text-sol-base01"}>
              {hasGitHub ? "✓" : "○"}
            </span>
            Code review with inline comments
          </li>
          <li className="flex items-center gap-2">
            <span className={hasGitHub ? "text-sol-green" : "text-sol-base01"}>
              {hasGitHub ? "✓" : "○"}
            </span>
            Sync team members from GitHub org
          </li>
          <li className="flex items-center gap-2">
            <span className={hasGitHub ? "text-sol-green" : "text-sol-base01"}>
              {hasGitHub ? "✓" : "○"}
            </span>
            Link AI sessions to commits and PRs
          </li>
          <li className="flex items-center gap-2">
            <span className={hasGitHub ? "text-sol-green" : "text-sol-base01"}>
              {hasGitHub ? "✓" : "○"}
            </span>
            Sync commit history with diffs
          </li>
        </ul>
        {hasGitHub && (
          <p className="mt-4 text-xs text-sol-base01">
            Use "Reconfigure" to update GitHub permissions if you need access to additional repositories or organizations.
          </p>
        )}
      </Card>

      <Card className="p-6 bg-sol-bg border-sol-border border-red-500/30">
        <h2 className="text-lg font-semibold text-red-400 mb-4">Danger Zone</h2>
        <p className="text-sm text-sol-base1 mb-4">
          Permanently delete your account and all associated data. This action cannot be undone.
        </p>

        {!showDeleteConfirm ? (
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(true)}
            className="text-red-400 border-red-500/30 hover:bg-red-500/10"
          >
            Delete Account
          </Button>
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-red-400 text-sm font-medium mb-2">
                This will permanently delete:
              </p>
              <ul className="text-sm text-red-300/80 space-y-1 list-disc list-inside">
                <li>All your conversations and messages</li>
                <li>All bookmarks and saved patterns</li>
                <li>All API tokens and integrations</li>
                <li>Your account and profile</li>
              </ul>
            </div>
            <div>
              <label className="block text-sm text-sol-text-muted mb-2">
                Type <span className="font-mono text-red-400">DELETE</span> to confirm:
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="w-full px-3 py-2 bg-sol-bg border border-sol-border rounded-lg text-sol-text focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
                placeholder="DELETE"
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmText("");
                }}
                className="text-sol-text border-sol-border"
              >
                Cancel
              </Button>
              <Button
                onClick={handleDeleteAccount}
                disabled={isDeleting || deleteConfirmText !== "DELETE"}
                className="bg-red-600 hover:bg-red-500 text-white disabled:opacity-50"
              >
                {isDeleting ? "Deleting..." : "Permanently Delete Account"}
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AccountsPage() {
  return (
    <Suspense fallback={<div className="text-sol-text-muted">Loading...</div>}>
      <AccountsContent />
    </Suspense>
  );
}
