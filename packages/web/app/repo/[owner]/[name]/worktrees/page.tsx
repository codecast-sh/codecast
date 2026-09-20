import { RepoSectionPage } from "../../../../../components/repo/RepoSectionPage";
import { useParams } from "next/navigation";
import { RepoWorktreesContent } from "../../../../../components/repo/RepoWorktreesContent";

export default function RepoWorktreesPage() {
  const params = useParams();
  return (
    <RepoSectionPage tab="worktrees" accent="var(--sol-cyan)">
      <RepoWorktreesContent repository={`${params.owner}/${params.name}`} />
    </RepoSectionPage>
  );
}
