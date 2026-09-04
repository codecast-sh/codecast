import { RepoSectionPage } from "../../../../../components/repo/RepoSectionPage";
import { useParams } from "next/navigation";
import { useRepoFamily } from "../../../../../components/repo/useRepoFamily";
import { RepoRefsContent } from "../../../../../components/repo/RepoRefsContent";

export default function RepoTagsPage() {
  const params = useParams();
  const family = useRepoFamily();
  return (
    <RepoSectionPage tab="tags" accent="var(--sol-blue)">
      <RepoRefsContent repository={`${params.owner}/${params.name}`} family={family} tags />
    </RepoSectionPage>
  );
}
