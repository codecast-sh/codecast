import { useParams, useSearchParams } from "next/navigation";
import { RepoSectionPage } from "../../../../../components/repo/RepoSectionPage";
import { RepoSearchContent } from "../../../../../components/repo/RepoSearchContent";
import { useRepoFamily } from "../../../../../components/repo/useRepoFamily";

export default function RepoSearchPage() {
  const params = useParams();
  const family = useRepoFamily();
  const q = useSearchParams().get("q") ?? "";

  return (
    <RepoSectionPage tab="search" accent="var(--sol-cyan)">
      <RepoSearchContent repository={`${params.owner}/${params.name}`} q={q} family={family} />
    </RepoSectionPage>
  );
}
