// Searching a repository's code.
//
// Two limits of GitHub's code search are stated on the page rather than hidden,
// because both would otherwise read as bugs. It indexes the default branch
// only, so a result is never "as of the ref you are browsing"; and it reports
// when its own index answered incompletely.
//
// The matches come back as a fragment plus offsets INTO THAT FRAGMENT. Those
// are not line numbers, and turning them into line numbers would cost a blob
// read for every row. So this highlights the matched span inside the fragment
// it was given and links to the file. A line number invented from a fragment
// offset would point at the wrong line, which is worse than not offering one.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCode } from "lucide-react";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { useRepoBranches, useRepoSearch } from "../../hooks/useRepoBrowse";
import { repoBlobHref, repoSearchHref, type RepoRouteFamily } from "../../lib/repoView";
import { serverErrorText } from "../../lib/errorCause";

/** The fragment split into plain and matched runs, in order. */
export function highlightRuns(
  fragment: string,
  indices: [number, number][],
): { text: string; hit: boolean }[] {
  const spans = [...indices]
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);

  const runs: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of spans) {
    // Overlapping spans would otherwise emit the same characters twice.
    if (start < at) continue;
    if (start > at) runs.push({ text: fragment.slice(at, start), hit: false });
    runs.push({ text: fragment.slice(start, end), hit: true });
    at = end;
  }
  if (at < fragment.length) runs.push({ text: fragment.slice(at), hit: false });
  return runs;
}

export function RepoSearchContent({ repository, q, family }: {
  repository: string; q: string; family: RepoRouteFamily;
}) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const read = useRepoSearch(repository, q || undefined, page);
  const branches = useRepoBranches(repository);
  // Search only ever indexes the default branch, so that is where a result lives.
  const ref = branches.data?.default_branch;
  const data = read.data;

  return <div className="max-w-[1000px] mx-auto">
    <form
      key={q}
      className="flex gap-2 mb-4"
      onSubmit={(event) => {
        event.preventDefault();
        const next = String(new FormData(event.currentTarget).get("q") || "").trim();
        setPage(1);
        router.push(repoSearchHref(repository, next, family));
      }}
    >
      <input
        name="q"
        defaultValue={q}
        aria-label="Search this repository's code"
        placeholder="Search this repository's code"
        className="flex-1 rounded border border-sol-border/60 bg-sol-bg px-3 py-2 text-sm"
      />
      <button className="rounded border border-sol-border px-3 text-sm text-sol-blue">Search</button>
    </form>

    {!q && <p className="py-8 text-center text-sol-text-dim">Type a query to search this repository&apos;s code.</p>}
    {q && read.error && <p className="py-4 text-sol-red">{serverErrorText(read.error)}</p>}
    {q && !read.ready && !read.error && <LoadingSkeleton />}

    {data && <>
      <div className="flex flex-wrap gap-x-4 gap-y-1 items-baseline text-xs text-sol-text-dim mb-3">
        <span className="text-sol-text">{data.total_count} {data.total_count === 1 ? "file" : "files"}</span>
        <span>on {ref ? <code className="font-mono">{ref}</code> : "the default branch"}, the only branch GitHub indexes</span>
        <a className="ml-auto text-sol-blue" target="_blank" rel="noopener noreferrer"
           href={`https://github.com/search?type=code&q=${encodeURIComponent(`repo:${repository} ${q}`)}`}>Search on GitHub</a>
      </div>
      {data.incomplete_results && <p className="mb-3 text-xs text-sol-yellow">GitHub timed out before finishing this search, so these results are partial.</p>}

      <div className="flex flex-col gap-3">
        {data.items.map((item) => <div key={item.path} className="border border-sol-border/50 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-sol-border/40 flex gap-2 items-center bg-sol-bg-alt/40">
            <FileCode className="size-3.5 shrink-0 text-sol-cyan" />
            {ref
              ? <Link href={repoBlobHref(repository, ref, item.path, family)} className="text-sol-blue text-xs truncate">{item.path}</Link>
              : <span className="text-xs truncate">{item.path}</span>}
          </div>
          {item.matches.map((match, at) => <pre
            key={at}
            className="px-3 py-2 text-[12px] font-mono whitespace-pre-wrap break-words border-t first:border-t-0 border-sol-border/30 text-sol-text-muted"
          >{highlightRuns(match.fragment, match.indices).map((run, i) => run.hit
            ? <mark key={i} className="bg-sol-yellow/25 text-sol-text rounded-sm">{run.text}</mark>
            : <span key={i}>{run.text}</span>)}</pre>)}
        </div>)}
      </div>

      {read.ready && data.items.length === 0 && <p className="p-8 text-center text-sol-text-dim">
        No code in this repository matches <code className="font-mono text-sol-text">{q}</code>.
      </p>}

      <div className="flex gap-3 items-center justify-center mt-4 text-xs">
        {page > 1 && <button className="text-sol-blue" onClick={() => setPage((p) => p - 1)}>Previous</button>}
        <span className="text-sol-text-dim">Page {page}</span>
        {data.items.length >= 30 && <button className="text-sol-blue" onClick={() => setPage((p) => p + 1)}>Next</button>}
      </div>
    </>}
  </div>;
}
