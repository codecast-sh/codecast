import { useParams } from "next/navigation";
import { RepoSectionPage } from "../../../../../components/repo/RepoSectionPage";
import { RepoPullsContent } from "../../../../../components/repo/RepoPullsContent";
import { useRepoFamily } from "../../../../../components/repo/useRepoFamily";

export default function RepoPullsPage() {
  const params = useParams();
  const family = useRepoFamily();

  return (
    <RepoSectionPage tab="pulls" accent="var(--sol-violet)">
      <RepoPullsContent repository={`${params.owner}/${params.name}`} family={family} />
    </RepoSectionPage>
  );
}
