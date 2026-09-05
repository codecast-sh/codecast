// Every pull request on a repository, filtered the way a person asks for them.
//
// GitHub's list endpoint knows three states: open, closed and all. The filters
// people actually want are finer than that — merged is a closed pull request
// that landed, "mine" is one they opened, "shepherded" is one codecast is
// driving — so each filter names the widest state GitHub can answer and then
// narrows the page in hand. That distinction matters in the empty state: this
// says nothing matched ON THIS PAGE rather than claiming none exist, because a
// match could sit on the next page it has not read.
//
// Mine and shepherded appear only when signed in. "Mine" needs a GitHub login
// to compare against, and the shepherd fields are joined by the signed-in read
// and deliberately absent from the public one, so offering either to a public
// reader would be a filter that silently matches nothing.
import { useState } from "react";
import Link from "next/link";
import { GitPullRequest, GitMerge } from "lucide-react";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { useRepoPulls, type RepoPull } from "../../hooks/useRepoBrowse";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { prPageHref, repoTreeHref, type RepoRouteFamily } from "../../lib/repoView";
import { relTimeShort } from "../../lib/utils";
import { serverErrorText } from "../../lib/errorCause";

type Filter = "open" | "merged" | "closed" | "mine" | "shepherded";

/** The widest state GitHub can answer for each filter. */
const FETCH_STATE: Record<Filter, "open" | "closed" | "all"> = {
  open: "open", merged: "closed", closed: "closed", mine: "all", shepherded: "all",
};

const isMerged = (pull: RepoPull) => !!pull.merged_at;
const isShepherded = (pull: RepoPull) => !!pull.shepherd_enabled || !!pull.conversation_id;

function matches(pull: RepoPull, filter: Filter, login: string | undefined): boolean {
  if (filter === "open") return pull.state === "open";
  if (filter === "merged") return isMerged(pull);
  if (filter === "closed") return pull.state === "closed" && !isMerged(pull);
  if (filter === "mine") return !!login && pull.author_login?.toLowerCase() === login.toLowerCase();
  return isShepherded(pull);
}

function PullIcon({ pull }: { pull: RepoPull }) {
  if (isMerged(pull)) return <GitMerge className="size-4 mt-0.5 shrink-0 text-sol-violet" />;
  const tone = pull.state === "open" ? "text-sol-green" : "text-sol-red";
  return <GitPullRequest className={`size-4 mt-0.5 shrink-0 ${tone}`} />;
}

export function RepoPullsContent({ repository, family }: { repository: string; family: RepoRouteFamily }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [page, setPage] = useState(1);
  const { user } = useCurrentUser();
  const login = user?.github_username ?? undefined;
  const read = useRepoPulls(repository, FETCH_STATE[filter], page);

  const fetched = read.data?.pulls ?? [];
  const rows = fetched.filter((pull) => matches(pull, filter, login));
  // The signed-in read joins these; the public one never does.
  const joined = fetched.some((pull) => pull.shepherd_enabled !== undefined);

  // A tab that is currently selected always stays visible. Shepherded is
  // offered on the evidence of the page in hand, and that page changes as
  // somebody filters: without this, choosing it and landing on a page with no
  // codecast rows would remove the very tab that is selected, leaving a filter
  // in force with nothing on screen naming it.
  const tabs: { key: Filter; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "merged", label: "Merged" },
    { key: "closed", label: "Closed" },
    ...(login || filter === "mine" ? [{ key: "mine" as const, label: "Mine" }] : []),
    ...(joined || filter === "shepherded" ? [{ key: "shepherded" as const, label: "Shepherded" }] : []),
  ];

  const pick = (next: Filter) => { setFilter(next); setPage(1); };

  return <div className="max-w-[1200px] mx-auto">
    <div className="flex items-center gap-3 mb-4 flex-wrap">
      <h2 className="font-serif text-xl text-sol-text">Pull requests</h2>
      <div className="flex gap-1 ml-auto" role="tablist" aria-label="Filter pull requests">
        {tabs.map((tab) => <button
          key={tab.key}
          role="tab"
          aria-selected={filter === tab.key}
          onClick={() => pick(tab.key)}
          className={`rounded px-2.5 py-1 text-xs border transition-colors ${filter === tab.key
            ? "border-sol-border bg-sol-bg-alt text-sol-text"
            : "border-transparent text-sol-text-dim hover:text-sol-text"}`}
        >{tab.label}</button>)}
      </div>
    </div>

    {read.error && <p className="py-4 text-sol-red">{serverErrorText(read.error)}</p>}
    {!read.ready && !read.error && <LoadingSkeleton />}

    <div className="border border-sol-border/50 rounded-lg divide-y divide-sol-border/40 overflow-hidden">
      {rows.map((pull) => <div key={pull.number} className="px-4 py-3 flex gap-3 items-start">
        <PullIcon pull={pull} />
        <div className="flex-1 min-w-0">
          <div className="flex gap-2 items-baseline flex-wrap">
            <Link href={prPageHref(repository, pull.number, family)} className="text-sol-text hover:text-sol-blue">{pull.title}</Link>
            {/* GitHub keeps draft:true on a pull request that was merged from
                draft, and shows no badge for it — once merged, draft is moot and a
                row saying both reads as a contradiction. */}
            {pull.draft && pull.state === "open" && <span className="text-[10px] border border-sol-border rounded-full px-2 text-sol-text-dim">draft</span>}
            {pull.labels.map((label) => <span
              key={label.name}
              className="text-[10px] rounded-full px-2 border"
              style={{ borderColor: `#${label.color}`, color: `#${label.color}` }}
            >{label.name}</span>)}
          </div>
          <div className="flex flex-wrap gap-2 text-xs mt-1.5 text-sol-text-dim">
            <span>#{pull.number}</span>
            {pull.author_login && <span>{pull.author_login}</span>}
            {pull.head_ref && <Link className="hover:text-sol-text" href={repoTreeHref(repository, pull.head_ref, undefined, family)}>{pull.head_ref}</Link>}
            {!!pull.updated_at && <time title={new Date(pull.updated_at).toLocaleString()}>updated {relTimeShort(pull.updated_at)}</time>}
            {isShepherded(pull) && <span className="text-sol-cyan">shepherded</span>}
          </div>
        </div>
      </div>)}

      {read.ready && rows.length === 0 && <p className="p-8 text-center text-sol-text-dim">
        {fetched.length === 0
          ? `No ${filter === "open" ? "open " : ""}pull requests on this page.`
          : `Nothing matching ${filter} among the ${fetched.length} pull requests read so far.`}
      </p>}
    </div>

    {/* Keyed to what GitHub returned, not to what survived the filter: a page
        that filtered down to nothing can still have a next one. */}
    <div className="flex gap-3 items-center justify-center mt-4 text-xs">
      {page > 1 && <button className="text-sol-blue" onClick={() => setPage((p) => p - 1)}>Newer</button>}
      <span className="text-sol-text-dim">Page {page}</span>
      {fetched.length >= 50 && <button className="text-sol-blue" onClick={() => setPage((p) => p + 1)}>Older</button>}
    </div>
  </div>;
}
