// A repository page that has its route but not yet its content.
//
// The header, the shell and the family are the same for every one of them, so
// they live here once and each page says only which tab it is and what it will
// show. The body is one muted line and nothing else: an empty page that says
// what it is beats a page that invents rows to fill itself.
import type { ReactNode } from "react";
import { useParams } from "next/navigation";
import { RepoHeader, type RepoTab } from "./RepoChrome";
import { RepoPageShell } from "./RepoPageShell";
import { useRepoFamily } from "./useRepoFamily";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import "./repo.css";

export function RepoSectionPage({
  tab,
  accent,
  refName,
  children,
  flush = false,
}: {
  tab: RepoTab;
  /** The solarized variable this page's chrome is keyed to. */
  accent: string;
  refName?: string;
  children: ReactNode;
  flush?: boolean;
}) {
  const params = useParams();
  const family = useRepoFamily();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;

  return (
    <RepoPageShell repository={repository}>
      <div className="repo-page h-full flex flex-col" style={{ ["--repo-accent" as string]: accent }}>
        <RepoHeader
          headRef={titlebarRef}
          repository={repository}
          tab={tab}
          refName={refName}
          family={family}
        />
        <div className={`flex-1 min-h-0 text-[13px] text-sol-text-muted ${flush ? "" : "overflow-y-auto px-4 py-6"}`}>
          {children}
        </div>
      </div>
    </RepoPageShell>
  );
}
