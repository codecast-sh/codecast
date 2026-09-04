// The source tree at one ref.
//
// The listing itself is components/repo/TreeContent, because the repository
// home renders the same thing at the default branch.
import { useParams, useSearchParams } from "next/navigation";
import { RepoHeader } from "../../../../../../components/repo/RepoChrome";
import { RepoRefPicker } from "../../../../../../components/repo/RepoRefPicker";
import { RepoPageShell } from "../../../../../../components/repo/RepoPageShell";
import { Breadcrumb, TreeContent } from "../../../../../../components/repo/TreeContent";
import { useRepoFamily } from "../../../../../../components/repo/useRepoFamily";
import { useTitlebarHead } from "../../../../../../hooks/useTitlebarHead";
import "../../../../../../components/repo/repo.css";

export default function RepoTreePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const family = useRepoFamily();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;
  const refName = decodeURIComponent((params.ref as string) ?? "");
  const path = searchParams.get("path") ?? "";

  return (
    <RepoPageShell repository={repository}>
      <div
        className="repo-page h-full flex flex-col"
        style={{ ["--repo-accent" as string]: "var(--sol-blue)" }}
      >
        <RepoHeader
          headRef={titlebarRef}
          repository={repository}
          tab="code"
          refName={refName}
          family={family}
          middle={<RepoRefPicker repository={repository} refName={refName} path={path} family={family} />}
          below={<Breadcrumb repository={repository} refName={refName} path={path} family={family} />}
        />
        <TreeContent repository={repository} refName={refName} path={path} family={family} />
      </div>
    </RepoPageShell>
  );
}
