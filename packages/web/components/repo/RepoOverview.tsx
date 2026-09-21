import Link from "next/link";
import { useRepoLog, useRepoMeta, useRepoSessions } from "../../hooks/useRepoBrowse";
import { commitPageHref, formatSize, repoCommitsHref, repoPullsHref, repoSessionsHref, sessionHref, type RepoRouteFamily } from "../../lib/repoView";
import { safeRepoUrl } from "../../lib/repoContent";
import { relTimeShort } from "../../lib/utils";
import { AuthorAvatar } from "../entityDisplay";
import { RepoReadme } from "./RepoReadme";
import { TreeContent } from "./TreeContent";

const RECENT_SESSIONS = 5;

/**
 * The newest sessions that shaped the repository, beside the About block: the
 * thing this page knows that GitHub's does not. Signed in it is the viewer's
 * own view of the team's work; on the public page it is the sessions their
 * owners chose to show, and it says nothing while there are none.
 */
function RecentSessions({ repository, family }: { repository: string; family: RepoRouteFamily }) {
  const sessions = useRepoSessions(repository);
  const rows = (sessions.data ?? []).slice(0, RECENT_SESSIONS);
  if (rows.length === 0) return null;
  return <section className="border-t border-sol-border/50 pt-4 space-y-3">
    <h3 className="font-serif text-lg">Sessions</h3>
    <ul className="space-y-2">
      {rows.map((row) => {
        const href = sessionHref(row);
        const label = <span className="truncate">{row.title}</span>;
        return <li key={row.conversation_id} className="flex items-center gap-2 min-w-0">
          <AuthorAvatar name={row.author_name} avatar={row.author_image} size={14} />
          {href ? <Link href={href} className="min-w-0 flex-1 truncate text-sol-text hover:text-sol-blue">{label}</Link> : <span className="min-w-0 flex-1 truncate text-sol-text">{label}</span>}
          <span className="shrink-0 text-sol-text-dim tabular-nums" title={`${row.commits.length} commits, ${row.files_total} files`}>{relTimeShort(row.updated_at)}</span>
        </li>;
      })}
    </ul>
    <Link href={repoSessionsHref(repository, family)} className="block text-sol-blue hover:underline">All sessions</Link>
  </section>;
}

export function RepoOverview({ repository, refName, family }: { repository: string; refName: string; family: RepoRouteFamily }) {
  const meta = useRepoMeta(repository);
  const history = useRepoLog(repository, refName, undefined);
  const latest = history.commits[0];
  const info = meta.data;
  const languages = Object.entries(info?.languages ?? {}).sort((a, b) => b[1] - a[1]);
  const total = languages.reduce((sum, [, bytes]) => sum + bytes, 0);
  const homepage = info?.homepage ? safeRepoUrl(info.homepage) : undefined;
  return <div className="flex-1 min-h-0 overflow-y-auto p-4">
    <div className="repo-overview grid gap-6 max-w-[1400px] mx-auto">
      <div className="min-w-0 space-y-5">
        <section className="rounded-lg border border-sol-border/60 overflow-hidden">
          {latest && <div className="flex items-center gap-3 px-4 py-3 bg-sol-bg-alt/40 border-b border-sol-border/50 text-xs">
            {latest.author_avatar_url && <img src={latest.author_avatar_url} alt="" className="size-5 rounded-full" />}
            <span className="shrink-0">{latest.author_login || latest.author_name}</span>
            <Link href={commitPageHref(repository, latest.sha, family)} className="truncate text-sol-text-muted hover:text-sol-blue">{latest.message.split("\n")[0]}</Link>
            <span className="ml-auto shrink-0 text-sol-text-dim">{relTimeShort(latest.timestamp)}</span>
            <Link href={repoCommitsHref(repository, refName, { family })} className="text-sol-blue">History</Link>
          </div>}
          <TreeContent repository={repository} refName={refName} path="" family={family} embedded />
        </section>
        <RepoReadme repository={repository} refName={refName} family={family} />
      </div>
      <aside className="min-w-0 text-xs space-y-5">
        <h2 className="font-serif text-xl">About</h2>
        {info ? <>
          <p className="text-[13px] leading-relaxed text-sol-text-muted">{info.description || "No description provided."}</p>
          {homepage && <a href={homepage} target="_blank" rel="noopener noreferrer" className="block truncate text-sol-blue hover:underline">{info.homepage}</a>}
          {info.topics.length > 0 && <div className="flex flex-wrap gap-1.5">{info.topics.map((topic) => <a key={topic} href={`https://github.com/topics/${encodeURIComponent(topic)}`} className="rounded-full bg-sol-blue/10 text-sol-blue px-2 py-1">{topic}</a>)}</div>}
          <dl className="grid grid-cols-2 gap-y-2 text-sol-text-muted">
            <dt>Default branch</dt><dd className="text-right truncate">{info.default_branch}</dd>
            <dt>Repository size</dt><dd className="text-right">{formatSize(info.size * 1024)}</dd>
            <dt>Stars</dt><dd className="text-right">{info.stargazers_count.toLocaleString()}</dd>
            <dt>Forks</dt><dd className="text-right">{info.forks_count.toLocaleString()}</dd>
            {info.open_pulls_count !== undefined && <><dt>Open pull requests</dt><dd className="text-right"><Link href={repoPullsHref(repository, family)} className="text-sol-blue">{info.open_pulls_count}</Link></dd></>}
            {info.license && <><dt>License</dt><dd className="text-right">{info.license}</dd></>}
          </dl>
          {info.archived && <p className="text-sol-text-muted">This repository is archived.</p>}
          <RecentSessions repository={repository} family={family} />
          {languages.length > 0 && <section className="border-t border-sol-border/50 pt-4 space-y-3">
            <h3 className="font-serif text-lg">Languages</h3>
            <div className="flex h-2 overflow-hidden rounded-full" aria-hidden="true">{languages.map(([language, bytes], i) => <div key={language} className="bg-sol-blue border-r border-sol-bg" style={{ width: `${bytes / total * 100}%`, opacity: Math.max(.2, 1 - i * .15) }} />)}</div>
            <ul className="space-y-2">{languages.map(([language, bytes]) => <li key={language} className="flex justify-between"><span>{language}</span><span className="text-sol-text-dim">{(bytes / total * 100).toFixed(1)}%</span></li>)}</ul>
          </section>}
        </> : <p className="text-sol-text-dim">{meta.error ? "Repository details unavailable." : "Reading repository details…"}</p>}
      </aside>
    </div>
  </div>;
}
