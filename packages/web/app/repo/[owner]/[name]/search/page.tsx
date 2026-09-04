import { useSearchParams } from "next/navigation";
import { RepoSectionPage } from "../../../../../components/repo/RepoSectionPage";

export default function RepoSearchPage() {
  const q = useSearchParams().get("q") ?? "";

  return (
    <RepoSectionPage tab="search" accent="var(--sol-cyan)">
      <p>
        {q ? (
          <>
            Matches for <code className="font-mono text-sol-text">{q}</code> across this
            repository&apos;s code, with the line each one is on.
          </>
        ) : (
          "Search this repository's code, with the line each match is on."
        )}
      </p>
    </RepoSectionPage>
  );
}
