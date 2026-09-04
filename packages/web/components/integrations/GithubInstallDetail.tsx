// The GitHub card's expandable detail: which accounts the App is installed on
// and which repositories each one can see. Mounted only while expanded, so the
// query costs nothing on a page nobody opened it on.
//
// useQueryNoThrow, not useQuery: this ENRICHES the GitHub card. If the query
// never answers, the card still says everything that matters — connected, by
// whom, how to disconnect — so a failure here must not take the card down.

import { useSettingsData } from "../../hooks/useSyncSettings";
import { BookMarked, Loader2 } from "lucide-react";
import { LedgerLine } from "./parts";

export function GithubInstallDetail({ teamId }: { teamId: string | undefined }) {
  const { data: installations, error } = useSettingsData("githubInstallations", teamId ?? null);

  if (!teamId) {
    return <p className="mt-2 text-xs text-sol-text-muted">The App binds to a team; this account has none.</p>;
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
  if (installations.length === 0) {
    return <p className="mt-2 text-xs text-sol-text-muted">No installation on this team yet.</p>;
  }

  return (
    <div className="mt-2 space-y-2.5 rounded-md bg-sol-bg-highlight/30 px-3 py-2.5">
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
                href={`https://github.com/settings/installations/${install.installation_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-[11px] text-sol-cyan hover:underline"
              >
                Configure on GitHub
              </a>
            </div>
            <LedgerLine
              parts={[
                allRepos ? "all repositories" : `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`,
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
  );
}
