import { useRouter } from "next/navigation";
import { useRepoBranches, useRepoTags } from "../../hooks/useRepoBrowse";
import { repoBlobHref, repoTreeHref, type RepoRouteFamily } from "../../lib/repoView";
import { BranchPicker } from "./RepoChrome";

export function RepoRefPicker({ repository, refName, path = "", blob = false, family }: {
  repository: string; refName: string; path?: string; blob?: boolean; family: RepoRouteFamily;
}) {
  const branches = useRepoBranches(repository);
  const tags = useRepoTags(repository);
  const router = useRouter();
  return <BranchPicker branches={branches.data?.branches ?? []} tags={tags.data?.tags ?? []} value={refName}
    defaultBranch={branches.data?.default_branch}
    onPick={(ref) => router.push(blob ? repoBlobHref(repository, ref, path, family) : repoTreeHref(repository, ref, path, family))} />;
}
