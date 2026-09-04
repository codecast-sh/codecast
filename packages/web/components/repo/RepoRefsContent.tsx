import { useState } from "react";
import Link from "next/link";
import { GitBranch, Tag } from "lucide-react";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { useRepoBranchDetails, useRepoBranches, useRepoTags } from "../../hooks/useRepoBrowse";
import { commitPageHref, prPageHref, repoCompareHref, repoTreeHref, type RepoRouteFamily } from "../../lib/repoView";
import { relTimeShort } from "../../lib/utils";
import { serverErrorText } from "../../lib/errorCause";

export function RepoRefsContent({ repository, family, tags = false }: { repository: string; family: RepoRouteFamily; tags?: boolean }) {
  const branches = useRepoBranchDetails(tags ? undefined : repository);
  const tagList = useRepoTags(tags ? repository : undefined);
  const defaults = useRepoBranches(repository);
  const [filter, setFilter] = useState("");
  const defaultBranch = branches.data?.default_branch || defaults.data?.default_branch;
  const read = tags ? tagList : branches;
  const rows = (tags
    ? (tagList.data?.tags ?? []).map((row) => ({ ...row, kind: "tag" as const }))
    : (branches.data?.branches ?? []).map((row) => ({ ...row, kind: "branch" as const }))
  ).filter((row) => row.name.toLowerCase().includes(filter.toLowerCase()));
  const Icon = tags ? Tag : GitBranch;
  return <div className="max-w-[1200px] mx-auto">
    <div className="flex items-center gap-3 mb-4">
      <h2 className="font-serif text-xl text-sol-text">{tags ? "Tags" : "Branches"}</h2>
      <input aria-label={`Filter ${tags ? "tags" : "branches"}`} placeholder={`Find a ${tags ? "tag" : "branch"}`} value={filter} onChange={(e) => setFilter(e.target.value)} className="ml-auto border border-sol-border/60 rounded bg-sol-bg px-3 py-1.5 text-xs" />
    </div>
    {read.error && <p className="py-4 text-sol-red">{serverErrorText(read.error)}</p>}
    {!read.ready && !read.error && <LoadingSkeleton />}
    {read.data?.truncated && <p className="mb-4 text-xs text-sol-yellow">Showing the first 100 {tags ? "tags" : "branches"} returned by GitHub. More may exist. <a className="underline" href={`https://github.com/${repository}/${tags ? "tags" : "branches"}`}>View all on GitHub</a></p>}
    <div className="border border-sol-border/50 rounded-lg divide-y divide-sol-border/40 overflow-hidden">
      {rows.map((row) => <div key={row.name} className="px-4 py-4 flex gap-3 items-start">
        <Icon className="size-4 mt-1 shrink-0 text-sol-blue" />
        <div className="flex-1 min-w-0">
          <div className="flex gap-2 items-center"><Link href={repoTreeHref(repository, tags ? `refs/tags/${row.name}` : row.name, undefined, family)} className="text-sol-blue truncate">{row.name}</Link>
            {!tags && row.name === defaultBranch && <span className="text-[10px] border border-sol-border rounded-full px-2">default</span>}
          </div>
          <div className="flex flex-wrap gap-2 text-xs mt-2 text-sol-text-dim">
            <Link href={commitPageHref(repository, row.sha, family)} className="hover:text-sol-text">{row.sha?.slice(0, 7)}</Link>
            {row.subject && <Link className="truncate max-w-[50ch] hover:text-sol-text" href={commitPageHref(repository, row.sha, family)}>{row.subject}</Link>}
            {row.author_login && <span>{row.author_login}</span>}
            {!!row.committed_at && <time title={new Date(row.committed_at).toLocaleString()}>{relTimeShort(row.committed_at)}</time>}
          </div>
          {row.kind === "branch" && row.open_pr && <Link className="inline-block mt-2 text-xs text-sol-blue" href={prPageHref(repository, row.open_pr.number, family)}>#{row.open_pr.number} {row.open_pr.title}</Link>}
        </div>
        <div className="flex flex-col gap-2 text-xs text-right shrink-0">
          {row.kind === "branch" && row.ahead_by !== undefined && row.behind_by !== undefined && <span title={`Compared with ${defaultBranch}`}>{row.ahead_by} ahead · {row.behind_by} behind</span>}
          {row.kind === "branch" && (row.ahead_by === undefined || row.behind_by === undefined) && <span className="text-sol-text-dim">Comparison unavailable</span>}
          {defaultBranch && (tags || row.name !== defaultBranch) && <Link className="text-sol-blue" href={repoCompareHref(repository, defaultBranch, row.sha, family)}>Compare</Link>}
        </div>
      </div>)}
      {read.ready && rows.length === 0 && <p className="p-8 text-center text-sol-text-dim">{filter ? "No matching refs." : `No ${tags ? "tags" : "branches"} found.`}</p>}
    </div>
  </div>;
}
