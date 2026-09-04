// A directory listing at one ref, and the breadcrumb that climbs out of it.
//
// A directory wants to be scanned, not read: folders first, one line each, a
// filter that narrows as you type, and j/k/enter so the keyboard never has to
// leave the list. The repository home and the tree page both render this, in
// either route family, so browsing behaves the same everywhere.
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { File, Folder, Search } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { useEventListener } from "../../hooks/useEventListener";
import { useRepoTree, useRepoLastCommits } from "../../hooks/useRepoBrowse";
import { repoShortcutAllowed } from "../../lib/repoContent";
import { relTimeShort } from "../../lib/utils";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  breadcrumbTrail,
  entryName,
  filterTreeEntries,
  formatSize,
  joinPath,
  moveCursor,
  repoBlobHref,
  commitPageHref,
  repoTreeHref,
  sortTreeEntries,
  type RepoRouteFamily,
} from "../../lib/repoView";
import { serverErrorText } from "../../lib/errorCause";

/** The breadcrumb, which is also how you climb back out. */
export function Breadcrumb({
  repository,
  refName,
  path,
  family = "app",
}: {
  repository: string;
  refName: string;
  path: string;
  family?: RepoRouteFamily;
}) {
  const trail = breadcrumbTrail(path);
  return (
    <div className="flex items-center gap-1 px-4 pb-2 text-[12px] flex-wrap">
      <Link
        href={repoTreeHref(repository, refName, undefined, family)}
        className={path ? "text-sol-text-muted hover:text-sol-text" : "text-sol-text"}
      >
        {repository.split("/")[1]}
      </Link>
      {trail.map((crumb, i) => (
        <span key={crumb.path} className="flex items-center gap-1">
          <span className="text-sol-text-dim">/</span>
          {i === trail.length - 1 ? (
            <span className="text-sol-text">{crumb.name}</span>
          ) : (
            <Link
              href={repoTreeHref(repository, refName, crumb.path, family)}
              className="text-sol-text-muted hover:text-sol-text"
            >
              {crumb.name}
            </Link>
          )}
        </span>
      ))}
    </div>
  );
}

export function TreeContent({
  repository,
  refName,
  path,
  family = "app",
  embedded = false,
}: {
  repository: string;
  refName: string;
  path: string;
  family?: RepoRouteFamily;
  embedded?: boolean;
}) {
  const router = useRouter();
  const tree = useRepoTree(repository, refName, path);
  const lastCommits = useRepoLastCommits(tree.data?.sha ? repository : undefined, refName, path, tree.data?.sha);
  const rootRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => {
    const all = sortTreeEntries(tree.data?.entries ?? []);
    return filterTreeEntries(all, filter);
  }, [tree.data, filter]);

  // A narrower list must not leave the cursor past its end.
  useWatchEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  const hrefFor = (entry: { path: string; type: string }) => {
    const full = joinPath(path, entryName(entry.path));
    return entry.type === "tree"
      ? repoTreeHref(repository, refName, full, family)
      : repoBlobHref(repository, refName, full, family);
  };

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!repoShortcutAllowed(rootRef.current, e) && e.target !== filterRef.current) return;
    if (!rootRef.current?.getClientRects().length) return;
    const el = e.target as HTMLElement | null;
    const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === "/" && !typing) {
      e.preventDefault();
      filterRef.current?.focus();
      return;
    }
    if (typing && e.key !== "Enter" && e.key !== "Escape") return;
    if (e.key === "Escape") {
      filterRef.current?.blur();
      return;
    }
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => moveCursor(c, 1, entries.length));
      return;
    }
    if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => moveCursor(c, -1, entries.length));
      return;
    }
    if (e.key === "Enter") {
      const entry = entries[cursor];
      if (entry) {
        e.preventDefault();
        router.push(hrefFor(entry));
      }
    }
  });

  return (
    <div ref={rootRef} className={embedded ? "flex flex-col" : "flex-1 min-h-0 flex flex-col"}>
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30 shrink-0">
        <Search className="w-3.5 h-3.5 text-sol-text-dim" />
        <input
          ref={filterRef}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter this directory"
          className="flex-1 bg-transparent text-[12px] text-sol-text placeholder:text-sol-text-dim outline-none"
        />
        <span className="text-[11px] text-sol-text-dim">
          {entries.length} {entries.length === 1 ? "entry" : "entries"}
        </span>
      </div>

      <div className={embedded ? "" : "flex-1 min-h-0 overflow-y-auto"}>
        {tree.error && (
          <p className="px-4 py-3 text-[12px] text-sol-red">
            This tree could not be read: {serverErrorText(tree.error)}
          </p>
        )}
        {tree.notFound && (
          <p className="px-4 py-3 text-[12px] text-sol-text-muted">
            There is no directory at <code className="font-mono">{path}</code> on this ref.
          </p>
        )}
        {!tree.ready && !tree.error && !tree.notFound && <LoadingSkeleton />}
        {tree.data?.truncated && (
          <p className="px-4 py-2 text-[11px] text-sol-yellow">
            GitHub truncated this listing, so some entries are missing.
          </p>
        )}

        <div className="divide-y divide-sol-border/20">
          {entries.map((entry, i) => {
            const name = entryName(entry.path);
            const isDir = entry.type === "tree";
            const last = lastCommits.data?.[joinPath(path, name)];
            return (
              <div
                key={entry.sha + name}
                onMouseEnter={() => setCursor(i)}
                className={`flex items-center gap-2 px-4 py-1.5 text-[12px] transition-colors ${
                  i === cursor ? "bg-sol-bg-alt/60" : "hover:bg-sol-bg-alt/40"
                }`}
              >
                <Link href={hrefFor(entry)} className="flex items-center gap-2 min-w-0 w-1/3 shrink-0">
                {isDir ? (
                  <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--repo-accent)" }} />
                ) : (
                  <File className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
                )}
                <span className={`truncate ${isDir ? "text-sol-text" : "text-sol-text-muted"}`}>{name}</span>
                </Link>
                {last ? <><Link href={commitPageHref(repository, last.sha, family)} className="truncate text-sol-text-muted hover:text-sol-blue flex-1" title={last.subject}>{last.subject}</Link>
                  <time title={new Date(last.committed_at).toLocaleString()} className="shrink-0 text-[11px] text-sol-text-dim">{relTimeShort(last.committed_at)}</time></>
                  : <span className="ml-auto text-[11px] text-sol-text-dim">{!isDir ? formatSize(entry.size) : ""}</span>}
              </div>
            );
          })}
        </div>

        {tree.ready && entries.length === 0 && !tree.notFound && (
          <p className="px-4 py-8 text-center text-[12px] text-sol-text-dim">
            {filter ? "Nothing here matches that." : "This directory is empty."}
          </p>
        )}
      </div>

      <footer className="flex items-center gap-3 px-4 py-1.5 border-t border-sol-border/40 text-[11px] text-sol-text-dim shrink-0">
        <span className="flex items-center gap-1">
          <KeyCap size="xs">j</KeyCap>
          <KeyCap size="xs">k</KeyCap>
          move
        </span>
        <span className="flex items-center gap-1">
          <KeyCap size="xs">enter</KeyCap>
          open
        </span>
        <span className="flex items-center gap-1">
          <KeyCap size="xs">/</KeyCap>
          filter
        </span>
      </footer>
    </div>
  );
}
