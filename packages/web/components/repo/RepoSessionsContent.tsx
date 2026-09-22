// The sessions that shaped a repository: the one tab GitHub has no answer to.
//
// One row per session, newest first, and on each row what the session did
// here: the commits it made and the files it touched, each a link into the
// same repository pages. Signed in, the list is every session the viewer may
// open, with the public ones marked. On the public page it is only the
// sessions their owners made public, each opening on its share page, so a
// stranger reads a curated set rather than a team's whole history.
import { useMemo, useState } from "react";
import Link from "next/link";
import { FileCode2, GitCommitHorizontal, Globe, MessagesSquare, Search } from "lucide-react";
import { AgentIcon } from "../ConversationList";
import { AuthorAvatar } from "../entityDisplay";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useRepoSessions, type RepoSession } from "../../hooks/useRepoBrowse";
import { useRepoTransport } from "../../lib/repoTransport";
import { serverErrorText } from "../../lib/errorCause";
import { commitPageHref, entryName, repoBlobHref, sessionHref, type RepoRouteFamily } from "../../lib/repoView";
import { relTimeShort } from "../../lib/utils";

const COMMITS_SHOWN = 4;

const firstName = (name: string | undefined) => name?.trim().split(/\s+/)[0] ?? "";

/** True when the row mentions the text: its title, a file, a commit subject, its author or branch. */
function sessionMatches(row: RepoSession, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return [row.title, row.author_name ?? "", row.branch ?? "", ...row.files, ...row.commits.map((c) => c.subject)]
    .some((text) => text.toLowerCase().includes(q));
}

/** The day a session last moved, as the section header above its rows. */
function dayOf(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function SessionTitle({ row, className }: { row: RepoSession; className: string }) {
  const href = sessionHref(row);
  return href ? <Link href={href} className={className}>{row.title}</Link> : <span className={className}>{row.title}</span>;
}

function SessionRow({ row, repository, family, now, index }: { row: RepoSession; repository: string; family: RepoRouteFamily; now: number; index: number }) {
  const mode = useRepoTransport();
  const insertions = row.commits.reduce((sum, c) => sum + c.insertions, 0);
  const deletions = row.commits.reduce((sum, c) => sum + c.deletions, 0);
  const hiddenCommits = row.commits.length - COMMITS_SHOWN;
  const hiddenFiles = row.files_total - row.files.length;
  return (
    <div
      className="repo-row repo-rise group flex items-start gap-3 px-4 py-3 hover:bg-sol-bg-alt/40 transition-colors"
      style={{ ["--d" as string]: `${Math.min(index, 14) * 25}ms` }}
    >
      <AuthorAvatar name={row.author_name} avatar={row.author_image} size={22} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <AgentIcon agentType={row.agent_type} className="w-3.5 h-3.5 shrink-0" />
          <SessionTitle row={row} className="text-[13px] text-sol-text hover:underline truncate" />
          {mode === "convex" && row.public && (
            <span className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-full border border-sol-green/40 text-[10px] text-sol-green shrink-0" title="Public: anyone with the link can read this session">
              <Globe className="w-2.5 h-2.5" />
              public
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
          {row.author_name && <span className="text-sol-text-muted">{firstName(row.author_name)}</span>}
          <span title={new Date(row.updated_at).toLocaleString()}>{relTimeShort(row.updated_at, now)}</span>
          <span className="inline-flex items-center gap-1" title={`${row.message_count} messages`}>
            <MessagesSquare className="w-3 h-3" />
            {row.message_count}
          </span>
          {row.branch && <span className="font-mono text-[10px] text-sol-cyan/80 truncate max-w-[16rem]">{row.branch}</span>}
        </div>
        {row.commits.length > 0 && (
          <ul className="space-y-0.5">
            {row.commits.slice(0, COMMITS_SHOWN).map((commit) => (
              <li key={commit.sha} className="flex items-center gap-2 text-[11px] min-w-0">
                <GitCommitHorizontal className="w-3 h-3 shrink-0 text-sol-text-dim" />
                <Link href={commitPageHref(repository, commit.sha, family)} className="font-mono text-[10px] shrink-0 hover:text-sol-text" style={{ color: "var(--repo-accent)" }}>
                  {commit.sha.slice(0, 7)}
                </Link>
                <Link href={commitPageHref(repository, commit.sha, family)} className="truncate text-sol-text-muted hover:text-sol-text">
                  {commit.subject}
                </Link>
                {commit.insertions > 0 && <span className="text-sol-green shrink-0 tabular-nums">+{commit.insertions}</span>}
                {commit.deletions > 0 && <span className="text-sol-red shrink-0 tabular-nums">−{commit.deletions}</span>}
              </li>
            ))}
            {hiddenCommits > 0 && <li className="text-[11px] text-sol-text-dim pl-5">{hiddenCommits} more {hiddenCommits === 1 ? "commit" : "commits"}</li>}
          </ul>
        )}
        {row.files.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {row.files.map((path) => (
              <Link
                key={path}
                href={repoBlobHref(repository, "HEAD", path, family)}
                className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded border border-sol-border/25 bg-sol-bg-alt/50 text-[10px] text-sol-text-muted hover:text-sol-text hover:border-sol-border/50 transition-colors max-w-[18rem]"
                title={path}
              >
                <FileCode2 className="w-2.5 h-2.5 shrink-0 opacity-70" />
                <span className="truncate">
                  {path.includes("/") && <span className="text-sol-text-dim">{path.slice(0, path.length - entryName(path).length)}</span>}
                  {entryName(path)}
                </span>
              </Link>
            ))}
            {hiddenFiles > 0 && <span className="text-[10px] text-sol-text-dim">+{hiddenFiles}</span>}
          </div>
        )}
      </div>
      {/* Only what the session is known to have done: a session whose work another one
          committed has no commits of its own, and a zero there reads as a verdict. */}
      <dl className="shrink-0 grid grid-cols-[auto_auto] gap-x-2 gap-y-0.5 text-[11px] text-sol-text-dim tabular-nums text-right pt-0.5">
        {row.commits.length > 0 && <><dt>{row.commits.length === 1 ? "commit" : "commits"}</dt><dd className="text-sol-text">{row.commits.length}</dd></>}
        {row.files_total > 0 && <><dt>{row.files_total === 1 ? "file" : "files"}</dt><dd className="text-sol-text">{row.files_total}</dd></>}
        {(insertions > 0 || deletions > 0) && (
          <>
            <dt>lines</dt>
            <dd><span className="text-sol-green">+{insertions}</span> <span className="text-sol-red">−{deletions}</span></dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function RepoSessionsContent({ repository, family }: { repository: string; family: RepoRouteFamily }) {
  const mode = useRepoTransport();
  const read = useRepoSessions(repository);
  const now = useCoarseNow(60_000);
  const [filter, setFilter] = useState("");
  const [publicOnly, setPublicOnly] = useState(false);

  const all = useMemo(() => read.data ?? [], [read.data]);
  const rows = useMemo(
    () => all.filter((row) => sessionMatches(row, filter) && (!publicOnly || row.public)),
    [all, filter, publicOnly],
  );
  const publicCount = all.filter((row) => row.public).length;
  const commitCount = all.reduce((sum, row) => sum + row.commits.length, 0);

  return (
    <div className="max-w-[1200px] mx-auto">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <h2 className="font-serif text-xl text-sol-text">Sessions</h2>
        {read.ready && all.length > 0 && (
          <span className="text-[11px] text-sol-text-dim tabular-nums">
            {all.length} {all.length === 1 ? "session" : "sessions"}{commitCount > 0 ? ` · ${commitCount} ${commitCount === 1 ? "commit" : "commits"}` : ""}
            {mode === "convex" && publicCount > 0 ? ` · ${publicCount} public` : ""}
          </span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          {mode === "convex" && publicCount > 0 && (
            <button
              type="button"
              role="switch"
              aria-checked={publicOnly}
              onClick={() => setPublicOnly((v) => !v)}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs border transition-colors ${publicOnly ? "border-sol-border bg-sol-bg-alt text-sol-text" : "border-transparent text-sol-text-dim hover:text-sol-text"}`}
            >
              <Globe className="w-3 h-3" />
              Public only
            </button>
          )}
          <label className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-dim focus-within:border-sol-border">
            <Search className="w-3.5 h-3.5" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by title, file or commit"
              aria-label="Filter sessions"
              className="bg-transparent outline-none text-sol-text placeholder:text-sol-text-dim w-56"
            />
          </label>
        </div>
      </div>

      {read.error && <p className="py-4 text-sol-red">{serverErrorText(read.error)}</p>}
      {!read.ready && !read.error && <LoadingSkeleton />}

      {read.ready && all.length === 0 && (
        <div className="px-6 py-16 text-center text-sol-text-muted">
          <MessagesSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
          {mode === "public" ? (
            <>
              <p className="text-[13px] mb-1">No public sessions yet.</p>
              <p className="text-[12px] text-sol-text-dim">
                A session becomes public when its owner runs <code className="font-mono text-sol-text">cast share &lt;session&gt; --public</code>.
              </p>
            </>
          ) : (
            <p className="text-[13px]">No session has touched this repository yet.</p>
          )}
        </div>
      )}

      {read.ready && all.length > 0 && rows.length === 0 && (
        <p className="px-6 py-10 text-center text-[13px] text-sol-text-dim">Nothing matches that filter.</p>
      )}

      {rows.length > 0 && (
        <div className="border border-sol-border/50 rounded-lg divide-y divide-sol-border/25 overflow-hidden">
          {rows.map((row, i) => (
            <div key={row.conversation_id}>
              {(i === 0 || dayOf(rows[i - 1].updated_at) !== dayOf(row.updated_at)) && (
                <h3 className="px-4 py-2 text-xs text-sol-text-muted bg-sol-bg-alt/30 border-b border-sol-border/25">{dayOf(row.updated_at)}</h3>
              )}
              <SessionRow row={row} repository={repository} family={family} now={now} index={i} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
