import { RepoSectionPage } from "../../../../../components/repo/RepoSectionPage";

export default function RepoPullsPage() {
  return (
    <RepoSectionPage tab="pulls" accent="var(--sol-violet)">
      <p>Every pull request on this repository, open and closed.</p>
    </RepoSectionPage>
  );
}
