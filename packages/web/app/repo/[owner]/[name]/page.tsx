// A repository's home: what you see when you name it and nothing else.
//
// GitHub answers that question with the source at the default branch, so this
// does too. The commit history moved to its own page (the Commits tab), and an
// older link that named a branch is sent there rather than dropped.
import type { RefCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { RepoHeader } from "../../../../components/repo/RepoChrome";
import { RepoPageShell } from "../../../../components/repo/RepoPageShell";
import { RepoOverview } from "../../../../components/repo/RepoOverview";
import { RepoRefPicker } from "../../../../components/repo/RepoRefPicker";
import { useRepoFamily } from "../../../../components/repo/useRepoFamily";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { useRepoBranches } from "../../../../hooks/useRepoBrowse";
import { useTitlebarHead } from "../../../../hooks/useTitlebarHead";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { repoCommitsHref, type RepoRouteFamily } from "../../../../lib/repoView";
import { serverErrorText } from "../../../../lib/errorCause";
import "../../../../components/repo/repo.css";

function RepoHomeContent({
  repository,
  family,
  headRef,
}: {
  repository: string;
  family: RepoRouteFamily;
  headRef: RefCallback<HTMLElement>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const branchParam = searchParams.get("branch");

  const branches = useRepoBranches(repository);
  const defaultBranch = branches.data?.default_branch ?? "";

  // `?branch=` is how the history page used to name a branch. People have that
  // link written down, so it lands on the same history, now at its own page.
  useWatchEffect(() => {
    if (branchParam) router.replace(repoCommitsHref(repository, branchParam, { family }));
  }, [branchParam, repository, family]);

  return (
    <div className="repo-page h-full flex flex-col" style={{ ["--repo-accent" as string]: "var(--sol-blue)" }}>
      <RepoHeader
        headRef={headRef}
        repository={repository}
        tab="code"
        refName={defaultBranch || "HEAD"}
        family={family}
        middle={<RepoRefPicker repository={repository} refName={defaultBranch || "HEAD"} family={family} />}
      />

      {branches.error && (
        <p className="px-4 py-3 text-[12px] text-sol-red">
          This repository could not be read: {serverErrorText(branches.error)}
        </p>
      )}

      {!defaultBranch && !branches.error ? (
        <LoadingSkeleton />
      ) : defaultBranch ? (
        <RepoOverview repository={repository} refName={defaultBranch} family={family} />
      ) : null}

    </div>
  );
}

export default function RepoHomePage() {
  const params = useParams();
  const family = useRepoFamily();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;

  return (
    <RepoPageShell repository={repository}>
      <RepoHomeContent repository={repository} family={family} headRef={titlebarRef} />
    </RepoPageShell>
  );
}
