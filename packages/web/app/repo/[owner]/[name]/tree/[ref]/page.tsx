// The source tree at one ref.
//
// A directory listing wants to be scanned, not read: folders first, one line
// each, a filter that narrows as you type, and j/k/enter so the keyboard never
// has to leave the list.
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { File, Folder, Search } from "lucide-react";
import { AuthGuard } from "../../../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../../../components/DashboardLayout";
import { KeyCap } from "../../../../../../components/KeyboardShortcutsHelp";
import { LoadingSkeleton } from "../../../../../../components/LoadingSkeleton";
import { RepoHeader } from "../../../../../../components/repo/RepoChrome";
import { useEventListener } from "../../../../../../hooks/useEventListener";
import { useRepoTree } from "../../../../../../hooks/useRepoBrowse";
import { useTitlebarHead } from "../../../../../../hooks/useTitlebarHead";
import { useWatchEffect } from "../../../../../../hooks/useWatchEffect";
import {
  breadcrumbTrail,
  entryName,
  filterTreeEntries,
  formatSize,
  joinPath,
  moveCursor,
  repoBlobHref,
  repoHistoryHref,
  repoTreeHref,
  sortTreeEntries,
} from "../../../../../../lib/repoView";
import "../../../../../../components/repo/repo.css";

/** The breadcrumb, which is also how you climb back out. */
function Breadcrumb({
  repository,
  refName,
  path,
}: {
  repository: string;
  refName: string;
  path: string;
}) {
  const trail = breadcrumbTrail(path);
  return (
    <div className="flex items-center gap-1 px-4 pb-2 text-[12px] flex-wrap">
      <Link
        href={repoTreeHref(repository, refName)}
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
              href={repoTreeHref(repository, refName, crumb.path)}
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

function TreeContent({
  repository,
  refName,
  path,
}: {
  repository: string;
  refName: string;
  path: string;
}) {
  const router = useRouter();
  const tree = useRepoTree(repository, refName, path);
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
      ? repoTreeHref(repository, refName, full)
      : repoBlobHref(repository, refName, full);
  };

  useEventListener("keydown", (e: KeyboardEvent) => {
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
    <div className="flex-1 min-h-0 flex flex-col">
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

      <div className="flex-1 min-h-0 overflow-y-auto">
        {tree.error && (
          <p className="px-4 py-3 text-[12px] text-sol-red">
            This tree could not be read: {tree.error.message}
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
            return (
              <Link
                key={entry.sha + name}
                href={hrefFor(entry)}
                onMouseEnter={() => setCursor(i)}
                className={`flex items-center gap-2 px-4 py-1.5 text-[12px] transition-colors ${
                  i === cursor ? "bg-sol-bg-alt/60" : "hover:bg-sol-bg-alt/40"
                }`}
              >
                {isDir ? (
                  <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--repo-accent)" }} />
                ) : (
                  <File className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
                )}
                <span className={isDir ? "text-sol-text" : "text-sol-text-muted"}>{name}</span>
                {!isDir && (
                  <span className="ml-auto text-[11px] text-sol-text-dim tabular-nums">
                    {formatSize(entry.size)}
                  </span>
                )}
              </Link>
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

export default function RepoTreePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const titlebarRef = useTitlebarHead<HTMLElement>();
  const repository = `${params.owner as string}/${params.name as string}`;
  const refName = decodeURIComponent((params.ref as string) ?? "");
  const path = searchParams.get("path") ?? "";

  return (
    <AuthGuard>
      <DashboardLayout>
        <div
          className="repo-page h-[calc(100vh-56px)] flex flex-col"
          style={{ ["--repo-accent" as string]: "var(--sol-blue)" }}
        >
          <RepoHeader
            headRef={titlebarRef}
            repository={repository}
            tab="code"
            historyHref={repoHistoryHref(repository, refName)}
            codeHref={repoTreeHref(repository, refName)}
            middle={
              <span className="h-7 flex items-center rounded-md border border-sol-border/60 bg-sol-card px-2 font-mono text-[12px] text-sol-text">
                {refName}
              </span>
            }
            below={<Breadcrumb repository={repository} refName={refName} path={path} />}
          />
          <TreeContent repository={repository} refName={refName} path={path} />
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
