// One file at one ref.
//
// The reading surface: highlighted source, line numbers that are anchors, an
// optional blame gutter, and comments written straight onto a line. A comment
// here is a codecast object first, so it carries the session the reader came
// from and shows up beside the code without a pull request existing.
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { RepoRefPicker } from "../../../../../../components/repo/RepoRefPicker";
import { RepoPageShell } from "../../../../../../components/repo/RepoPageShell";
import { Breadcrumb } from "../../../../../../components/repo/TreeContent";
import { useRepoFamily } from "../../../../../../components/repo/useRepoFamily";
import { BlobContent } from "../../../../../../components/repo/BlobContent";
import { RepoHeader } from "../../../../../../components/repo/RepoChrome";
import { useTitlebarHead } from "../../../../../../hooks/useTitlebarHead";
import { repoTreeHref } from "../../../../../../lib/repoView";
import "../../../../../../components/repo/repo.css";

export default function RepoBlobPage() {
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
          middle={<RepoRefPicker repository={repository} refName={refName} path={path} family={family} blob />}
          below={<Breadcrumb repository={repository} refName={refName} path={path} family={family} />}
        />
        {path ? (
          <BlobContent repository={repository} refName={refName} path={path} />
        ) : (
          <p className="px-6 py-10 text-[13px] text-sol-text-muted">
            This link names no file. Pick one from{" "}
            <Link
              href={repoTreeHref(repository, refName, undefined, family)}
              className="text-sol-blue hover:underline"
            >
              the source tree
            </Link>
            .
          </p>
        )}
      </div>
    </RepoPageShell>
  );
}
