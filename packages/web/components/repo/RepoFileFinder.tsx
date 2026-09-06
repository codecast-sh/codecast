// Jump to any file in the repository by typing part of its path.
//
// The index behind it is the whole tree in one read, which is the largest read
// on any repository page, so it is fetched only once somebody opens the finder
// and never on the way into a page. GitHub truncates very large trees and says
// so; when it does, this says so too rather than quietly offering a partial
// index as if it were the whole repository.
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileCode, Search } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useEventListener } from "../../hooks/useEventListener";
import { useRepoBranches, useRepoFileIndex } from "../../hooks/useRepoBrowse";
import { repoShortcutAllowed } from "../../lib/repoContent";
import { rankPaths } from "../../lib/fuzzyPath";
import { repoBlobHref, type RepoRouteFamily } from "../../lib/repoView";

export function RepoFileFinder({ repository, refName, family, anchorRef }: {
  repository: string;
  refName: string | undefined;
  family: RepoRouteFamily;
  /** The header band, so `t` only answers on the page a person is looking at. */
  anchorRef: { current: HTMLElement | null };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Branches, tags, pulls and search name no ref of their own, and RepoHeader
  // hands them the literal "HEAD" as its default. GitHub resolves HEAD, so a
  // file opened from there would load — but at a ref reading "HEAD" rather
  // than the branch, and every link leaving that page would carry it onward.
  // So HEAD is treated as "no ref chosen" and the real default branch is
  // resolved. Both reads are gated on `open`: nothing is fetched until
  // somebody actually asks for the finder.
  const explicit = refName && refName !== "HEAD" ? refName : undefined;
  const branches = useRepoBranches(open && !explicit ? repository : undefined);
  const ref = explicit ?? branches.data?.default_branch;

  // `enabled` is the whole point: no tree is read until the finder is opened.
  const index = useRepoFileIndex(repository, ref, open && !!ref);

  const files = useMemo(
    () => (index.data?.entries ?? []).filter((entry) => entry.type === "blob").map((entry) => entry.path),
    [index.data],
  );
  const hits = useMemo(() => rankPaths(files, query.trim()), [files, query]);

  useWatchEffect(() => { setCursor(0); }, [query]);
  useWatchEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  useEventListener("keydown", (event: KeyboardEvent) => {
    if (open || event.key !== "t") return;
    if (!repoShortcutAllowed(anchorRef.current, event)) return;
    event.preventDefault();
    setQuery("");
    setOpen(true);
  });

  if (!open) return null;

  const close = () => { setOpen(false); setQuery(""); };
  const go = (path: string) => {
    close();
    if (ref) router.push(repoBlobHref(repository, ref, path, family));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Find a file"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-sol-bg/70 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="w-[min(680px,92vw)] rounded-lg border border-sol-border bg-sol-card shadow-2xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-sol-border/60">
          <Search className="size-4 shrink-0 text-sol-text-dim" />
          <input
            ref={inputRef}
            value={query}
            aria-label="Find a file"
            placeholder="Find a file"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); close(); }
              if (event.key === "ArrowDown") { event.preventDefault(); setCursor((at) => Math.min(at + 1, hits.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setCursor((at) => Math.max(at - 1, 0)); }
              if (event.key === "Enter" && hits[cursor]) { event.preventDefault(); go(hits[cursor].path); }
            }}
            className="flex-1 bg-transparent py-3 text-sm outline-none text-sol-text"
          />
          <KeyCap size="xs">esc</KeyCap>
        </div>

        <div className="max-h-[52vh] overflow-y-auto">
          {!index.ready && !index.error && <p className="p-6 text-center text-xs text-sol-text-dim">Reading the file list…</p>}
          {index.error && <p className="p-6 text-center text-xs text-sol-red">The file list could not be read.</p>}
          {index.data?.truncated && <p className="px-3 py-2 text-[11px] text-sol-yellow border-b border-sol-border/40">
            This repository is large enough that GitHub returned only part of its file list, so some files are missing here.
          </p>}

          {hits.map((hit, at) => <button
            key={hit.path}
            onMouseEnter={() => setCursor(at)}
            onClick={() => go(hit.path)}
            className={`w-full text-left px-3 py-2 flex gap-2 items-center text-xs font-mono ${at === cursor ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-muted"}`}
          >
            <FileCode className="size-3.5 shrink-0 text-sol-cyan" />
            <span className="truncate">{hit.path}</span>
          </button>)}

          {index.ready && hits.length === 0 && <p className="p-6 text-center text-xs text-sol-text-dim">
            {query ? "No file matches that." : "This repository has no files at this ref."}
          </p>}
        </div>

        <div className="px-3 py-2 border-t border-sol-border/60 flex gap-3 items-center text-[11px] text-sol-text-dim">
          <span className="flex gap-1 items-center"><KeyCap size="xs">↑</KeyCap><KeyCap size="xs">↓</KeyCap> move</span>
          <span className="flex gap-1 items-center"><KeyCap size="xs">↵</KeyCap> open</span>
          {files.length > 0 && <span className="ml-auto">{files.length} files</span>}
        </div>
      </div>
    </div>
  );
}
