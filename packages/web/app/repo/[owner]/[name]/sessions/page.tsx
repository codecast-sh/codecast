import { useParams } from "next/navigation";
import { RepoSectionPage } from "../../../../../components/repo/RepoSectionPage";
import { RepoSessionsContent } from "../../../../../components/repo/RepoSessionsContent";
import { useRepoFamily } from "../../../../../components/repo/useRepoFamily";

export default function RepoSessionsPage() {
  const params = useParams();
  const family = useRepoFamily();

  return (
    <RepoSectionPage tab="sessions" accent="var(--sol-yellow)">
      <RepoSessionsContent repository={`${params.owner}/${params.name}`} family={family} />
    </RepoSectionPage>
  );
}
