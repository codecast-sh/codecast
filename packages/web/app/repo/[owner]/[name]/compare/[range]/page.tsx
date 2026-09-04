import { useParams } from "next/navigation";
import { RepoSectionPage } from "../../../../../../components/repo/RepoSectionPage";
import { parseCompareRange } from "../../../../../../lib/repoView";
import { useRepoFamily } from "../../../../../../components/repo/useRepoFamily";
import { RepoCompareContent } from "../../../../../../components/repo/RepoCompareContent";

export default function RepoComparePage() {
  const params = useParams();
  const range = parseCompareRange(params.range as string);
  const family = useRepoFamily();
  const repository = `${params.owner}/${params.name}`;

  return (
    // The compare page belongs to the commit list: it is the commits and the
    // diff between two refs, so it wears the same tab and the same accent.
    <RepoSectionPage tab="commits" accent="var(--sol-blue)" refName={range?.head} flush>
      {range ? <RepoCompareContent repository={repository} base={range.base} head={range.head} family={family} />
        : <p className="p-6 text-sm">A comparison needs two refs, written base...head.</p>}
    </RepoSectionPage>
  );
}
