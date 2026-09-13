// The GitHub card's ledger of what the App can reach: which accounts it is
// installed on and which repositories each one covers. Always shown, because
// "why is this repository not in my workspace?" is the question people bring
// here, and the answer is always in this list.
//
// useQueryNoThrow, not useQuery: this ENRICHES the GitHub card. If the query
// never answers, the card still says everything that matters — connected, by
// whom, how to disconnect — so a failure here must not take the card down.

import { useSettingsData } from "../../hooks/useSyncSettings";
import { BookMarked, Loader2 } from "lucide-react";
import type { AppConnectionScope } from "@codecast/shared/contracts";
import { LedgerLine } from "./parts";

export function GithubInstallDetail({ scope, teamId }: { scope: AppConnectionScope; teamId: string | undefined }) {
  // One query either way (githubApp.listInstallations): named a team it lists
  // the team's installs, with none it lists the caller's own.
  const team = scope === "team";
  const { data: installations, error } = useSettingsData(
    team ? "githubInstallations" : "personalGithubInstallations",
    team ? teamId ?? null : undefined,
  ) as { data: any[] | undefined; error: Error | null | undefined };

  if (team && !teamId) {
    return <p className="mt-2 text-xs text-sol-text-muted">A team install binds to a team; this account has none.</p>;
  }
  if (error && installations === undefined) {
    return <p className="mt-2 text-xs text-sol-red">Couldn&apos;t load the installations: {error.message}</p>;
  }
  if (installations === undefined) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-sol-text-muted">
        <Loader2 className="h-3 w-3 animate-spin" />
        Reading the installations
      </div>
    );
  }
  return (
    <div className="mt-2.5 rounded-md bg-sol-bg-highlight/30 px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-sol-text-dim">
        Accounts and repositories the App can see
      </div>
      {installations.length === 0 ? (
        <p className="mt-1.5 text-xs text-sol-text-muted">
          {team
            ? "No account or organization has the App for this team yet. Install it on the one that owns the repositories."
            : "No personal installation yet."}
        </p>
      ) : (
        <div className="mt-1.5 space-y-2.5">
          {installations.map((install: any) => {
            const repos = install.repositories ?? [];
            const allRepos = install.repository_selection === "all";
            return (
              <div key={install._id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-xs font-medium text-sol-text">
                    {install.account_login}
                    <span className="ml-1.5 font-mono text-[10px] text-sol-text-dim">{install.account_type}</span>
                  </span>
                  <a
                    href={githubInstallSettingsUrl(install)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-[11px] text-sol-cyan hover:underline"
                  >
                    Change repositories on GitHub
                  </a>
                </div>
                <LedgerLine
                  parts={[
                    allRepos
                      ? `every repository ${install.account_login} owns, now and later`
                      : `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`,
                    install.suspended_at ? "suspended" : null,
                  ]}
                />
                {!allRepos && repos.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {repos.map((repo: any) => (
                      <li key={repo.id} className="flex items-center gap-1.5">
                        <BookMarked className="h-3 w-3 shrink-0 text-sol-text-dim" />
                        <span className="truncate font-mono text-[11px] text-sol-text-muted">{repo.full_name}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-sol-text-dim">
        A repository owned by an account that is not listed here is invisible to codecast until the App
        is installed on that account. Which repositories an install covers is chosen on GitHub; codecast
        follows the change as soon as GitHub reports it and brings in the pull requests already there.
      </p>
    </div>
  );
}

/**
 * GitHub keeps an organization's installs under the organization's settings
 * and a person's under their own. The user-settings form 404s for an org
 * install unless GitHub happens to redirect, so the link names the right one.
 */
function githubInstallSettingsUrl(install: { account_type: string; account_login: string; installation_id: number }) {
  return install.account_type === "Organization"
    ? `https://github.com/organizations/${install.account_login}/settings/installations/${install.installation_id}`
    : `https://github.com/settings/installations/${install.installation_id}`;
}
