// Every repository this workspace can browse.
//
// The list is the point, so it is a list: one line per repository, with what is
// open on it and the last thing that happened there. Everything it needs is
// already local (pull requests and git events are store collections), so it
// paints on the first frame and the row count never flickers.
import { useCallback, useMemo } from "react";
import Link from "next/link";
import { FolderGit2, GitPullRequest } from "lucide-react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ExternalEventRow } from "../../components/feed/ExternalEventRow";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";
import { useRepositories } from "../../hooks/useRepoBrowse";
import { useExternalEvents } from "../../hooks/useSyncExternalEvents";
import { useSyncPullRequests, usePullRequests } from "../../hooks/useSyncTimeline";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { serverErrorText } from "../../lib/errorCause";
import { externalEventRowToExternalEvent } from "../../lib/externalEvents";
import "../../components/repo/repo.css";

function RepoList() {
  const { rows, ready, error } = useRepositories();

  useSyncPullRequests({ limit: 200 });
  const openPRs = usePullRequests(useCallback((pr: any) => pr.state === "open", []));
  const events = useExternalEvents();

  const byRepository = useMemo(() => {
    const prCount = new Map<string, number>();
    for (const pr of openPRs) {
      if (!pr.repository) continue;
      prCount.set(pr.repository, (prCount.get(pr.repository) ?? 0) + 1);
    }
    const lastEvent = new Map<string, any>();
    for (const event of events) {
      if (!event.repository || lastEvent.has(event.repository)) continue;
      lastEvent.set(event.repository, event);
    }
    return { prCount, lastEvent };
  }, [openPRs, events]);

  if (!ready && rows.length === 0 && !error) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className="px-6 py-10 text-[13px] text-sol-text-muted">
        Repositories could not be read: {serverErrorText(error)}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="px-6 py-16 text-center text-sol-text-muted">
        <FolderGit2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="text-[14px] mb-1">No repository is connected yet.</p>
        <p className="text-[12px] text-sol-text-dim">
          Install the GitHub App on a team from Settings and its repositories appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-sol-border/30">
      {rows.map((row, i) => {
        const [owner, name] = row.repository.split("/");
        // `row.installed` says whether the installation NAMED this repository,
        // which an all-repositories installation never does. It is not "the App
        // is missing", so it is not worth a badge that reads like a fault.
        const open = byRepository.prCount.get(row.repository) ?? 0;
        const event = byRepository.lastEvent.get(row.repository);
        return (
          <div
            key={row.repository}
            className="repo-row repo-rise px-4 py-3 hover:bg-sol-bg-alt/40 transition-colors"
            style={{ ["--d" as string]: `${Math.min(i, 12) * 30}ms` }}
          >
            <div className="flex items-baseline gap-2 flex-wrap">
              <Link href={`/repo/${row.repository}`} className="flex items-baseline gap-1 group">
                <span className="text-[12px] text-sol-text-dim">{owner}/</span>
                <span className="font-serif text-[17px] leading-none text-sol-text group-hover:underline">
                  {name}
                </span>
              </Link>
              {open > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] text-sol-green">
                  <GitPullRequest className="w-3 h-3" />
                  {open} open
                </span>
              )}
            </div>
            {event && (
              <div className="mt-1.5">
                <ExternalEventRow
                  event={externalEventRowToExternalEvent(event)}
                  density="compact"
                  showActor
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function RepositoriesPage() {
  const titlebarRef = useTitlebarHead<HTMLDivElement>();

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="repo-page h-[calc(100vh-56px)] flex flex-col">
          <header ref={titlebarRef} className="repo-band border-b border-sol-border/60 px-4 py-3 shrink-0">
            <h1 className="repo-rise font-serif text-[20px] leading-none text-sol-text">Repositories</h1>
            <p className="repo-rise mt-1.5 text-[12px] text-sol-text-muted" style={{ ["--d" as string]: "60ms" }}>
              History, source and every commit, with the sessions and tasks behind them.
            </p>
          </header>
          <div className="flex-1 min-h-0 overflow-y-auto">
            <RepoList />
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
