import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileDiffLayout } from "../FileDiffLayout";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { useRepoCompare } from "../../hooks/useRepoBrowse";
import { commitPageHref, repoCompareHref, type RepoRouteFamily } from "../../lib/repoView";
import { serverErrorText } from "../../lib/errorCause";

export function RepoCompareContent({ repository, base, head, family }: {
  repository: string; base: string; head: string; family: RepoRouteFamily;
}) {
  const router = useRouter();
  const comparison = useRepoCompare(repository, base, head);
  const data = comparison.data;
  const files = useMemo(() => (data?.files ?? []).map((file) => ({ ...file, changes: file.additions + file.deletions })), [data]);
  return <div className="flex flex-col h-full min-h-0">
    <form key={`${base}:${head}`} className="flex gap-2 px-4 py-3 border-b border-sol-border/40 text-xs" onSubmit={(event) => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      const nextBase = String(fields.get("base") || "").trim(); const nextHead = String(fields.get("head") || "").trim();
      if (nextBase && nextHead) router.push(repoCompareHref(repository, nextBase, nextHead, family));
    }}>
      <label className="flex items-center gap-2 min-w-0">Base <input name="base" defaultValue={base} className="min-w-0 w-44 rounded border border-sol-border bg-sol-bg px-2 py-1" /></label>
      <span className="self-center text-sol-text-dim">…</span>
      <label className="flex items-center gap-2 min-w-0">Head <input name="head" defaultValue={head} className="min-w-0 w-44 rounded border border-sol-border bg-sol-bg px-2 py-1" /></label>
      <button className="text-sol-blue">Compare</button>
    </form>
    {comparison.error && <p className="p-4 text-xs text-sol-red">{serverErrorText(comparison.error)}</p>}
    {!comparison.ready && !comparison.error && <LoadingSkeleton />}
    {data && <>
      <div className="px-4 py-3 border-b border-sol-border/40 text-xs flex flex-wrap gap-4">
        <span>{data.total_commits} commits</span><span>{files.length} files returned</span><span>{data.ahead_by} ahead</span><span>{data.behind_by} behind</span>
        <a href={`https://github.com/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`} target="_blank" rel="noopener noreferrer" className="ml-auto text-sol-blue">Compare on GitHub</a>
      </div>
      {(data.total_commits > data.commits.length || files.length >= 300 || data.files.some((file) => file.patch_truncated)) &&
        <p className="px-4 py-2 text-xs text-sol-yellow">GitHub limits comparison results. {data.total_commits > data.commits.length ? `Showing ${data.commits.length} of ${data.total_commits} commits. ` : ""}{files.length >= 300 ? "File list may be truncated at 300 files. " : ""}{data.files.some((file) => file.patch_truncated) ? "Some patches are truncated." : ""}</p>}
      {data.commits.length > 0 && <details className="border-b border-sol-border/40">
        <summary className="px-4 py-2 cursor-pointer text-xs">Commits in this comparison ({data.commits.length})</summary>
        <ol className="max-h-60 overflow-y-auto divide-y divide-sol-border/30">{data.commits.map((commit) => <li key={commit.sha} className="px-4 py-2 flex gap-3 text-xs">
          <Link href={commitPageHref(repository, commit.sha, family)} className="text-sol-blue shrink-0">{commit.sha.slice(0, 7)}</Link>
          <Link href={commitPageHref(repository, commit.sha, family)} className="truncate flex-1">{commit.message.split("\n")[0]}</Link>
          <span className="text-sol-text-dim">{commit.author_login || commit.author_name}</span>
        </li>)}</ol>
      </details>}
      <div className="flex-1 min-h-0">{files.length ? <FileDiffLayout files={files} title="Changed files" /> : <p className="p-8 text-sm text-sol-text-muted">No file changes between these refs.</p>}</div>
    </>}
  </div>;
}
