// The chrome every repository page shares: the header band with the
// repository's name, the ref it is showing, a way out to GitHub, a way into a
// window of its own, and the six tabs with their keyboard shortcuts.
import { useCallback, useRef, useState, type ReactNode, type RefCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronDown,
  Code2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  History,
  Search,
  Tag,
} from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useEventListener } from "../../hooks/useEventListener";
import {
  repoBranchesHref,
  repoCommitsHref,
  repoHomeHref,
  repoPullsHref,
  repoSearchHref,
  repoTagsHref,
  repoTreeHref,
  type RepoRouteFamily,
} from "../../lib/repoView";
import { RepoWindowControl } from "./RepoWindowControl";
import { cn } from "../../lib/utils";
import { repoShortcutAllowed } from "../../lib/repoContent";

export type RepoTab = "code" | "commits" | "branches" | "tags" | "pulls" | "search";

export function BranchPicker({
  branches,
  tags = [],
  value,
  defaultBranch,
  onPick,
}: {
  branches: { name: string; sha: string }[];
  tags?: { name: string; sha: string }[];
  value: string;
  defaultBranch?: string;
  onPick: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = [...branches.map((b) => ({ ...b, tag: false })), ...tags.map((b) => ({ ...b, tag: true }))]
    .filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 bg-sol-card px-2 text-[12px] text-sol-text hover:border-sol-border transition-colors"
        title="Switch branch or tag"
        aria-expanded={open}
      >
        <GitBranch className="w-3.5 h-3.5" style={{ color: "var(--repo-accent)" }} />
        <span className="max-w-[14rem] truncate">{value}</span>
        <ChevronDown className="w-3 h-3 text-sol-text-dim" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div role="dialog" aria-label="Switch branch or tag" aria-modal="true" className="absolute z-50 mt-1 w-72 rounded-lg border border-sol-border bg-sol-card shadow-lg overflow-hidden" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a branch or tag"
              className="w-full bg-transparent border-b border-sol-border/60 px-2.5 py-2 text-[12px] text-sol-text placeholder:text-sol-text-dim outline-none"
            />
            <div className="max-h-72 overflow-y-auto py-1">
              {shown.length === 0 && (
                <div className="px-2.5 py-3 text-[12px] text-sol-text-dim">No branch or tag matches.</div>
              )}
              {shown.map((branch) => (
                <button
                  key={`${branch.tag}:${branch.name}`}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onPick(branch.tag ? `refs/tags/${branch.name}` : branch.name);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-sol-text hover:bg-sol-bg-alt/60"
                >
                  <Check
                    className={cn("w-3 h-3 shrink-0", branch.name === value ? "opacity-100" : "opacity-0")}
                    style={{ color: "var(--repo-accent)" }}
                  />
                  <span className="truncate">{branch.name}</span>
                  {branch.tag && <span className="ml-auto text-[10px] text-sol-text-dim">tag</span>}
                  {!branch.tag && branch.name === defaultBranch && (
                    <span className="ml-auto text-[10px] text-sol-text-dim">default</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The band and the six tabs. The digits `1` to `6` move between them, ignored
 * while typing so a filter box can contain a digit.
 *
 * The header builds its own hrefs from the repository, the ref it is showing
 * and the route family, so no page has to spell out six links, and no page can
 * spell one of them in the other family by mistake.
 */
export function RepoHeader({
  repository,
  tab,
  refName = "HEAD",
  family = "app",
  middle,
  trailing,
  below,
  headRef,
}: {
  repository: string;
  tab: RepoTab;
  /** The branch, tag or sha the page is showing; the tree and commit tabs follow it. */
  refName?: string;
  family?: RepoRouteFamily;
  /** Zen mode on the desktop makes this band the window titlebar. */
  headRef?: RefCallback<HTMLElement>;
  /** The branch picker, or whatever the page wants beside the name. */
  middle?: ReactNode;
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  const router = useRouter();
  const [owner, name] = repository.split("/");

  // The band's own element, so the digit shortcuts below can tell whether this
  // copy of the header is the one on screen. A background tab keeps its pane
  // mounted under `display: none`, and every mounted copy would otherwise
  // answer the same keypress and move a page nobody is looking at.
  // offsetParent is null exactly then.
  const bandRef = useRef<HTMLElement | null>(null);
  const setBand = useCallback(
    (el: HTMLElement | null) => {
      bandRef.current = el;
      headRef?.(el);
    },
    [headRef],
  );

  const tabs: { key: RepoTab; label: string; href: string; icon: typeof History; digit: string }[] = [
    { key: "code", label: "Code", href: repoTreeHref(repository, refName, undefined, family), icon: Code2, digit: "1" },
    { key: "commits", label: "Commits", href: repoCommitsHref(repository, refName, { family }), icon: History, digit: "2" },
    { key: "branches", label: "Branches", href: repoBranchesHref(repository, family), icon: GitBranch, digit: "3" },
    { key: "tags", label: "Tags", href: repoTagsHref(repository, family), icon: Tag, digit: "4" },
    { key: "pulls", label: "Pull requests", href: repoPullsHref(repository, family), icon: GitPullRequest, digit: "5" },
    { key: "search", label: "Search", href: repoSearchHref(repository, undefined, family), icon: Search, digit: "6" },
  ];

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!repoShortcutAllowed(bandRef.current, e)) return;
    const hit = tabs.find((t) => t.digit === e.key);
    if (hit && hit.key !== tab) router.push(hit.href);
  });

  return (
    <header ref={setBand} className="repo-band border-b border-sol-border/60 shrink-0">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 flex-wrap">
        <h1 className="repo-rise flex items-baseline gap-1 min-w-0" style={{ ["--d" as string]: "0ms" }}>
          <Link href="/repo" className="text-[13px] text-sol-text-muted hover:text-sol-text transition-colors">
            {owner}
          </Link>
          <span className="text-sol-text-dim">/</span>
          <Link
            href={repoHomeHref(repository, family)}
            className="font-serif text-[19px] leading-none text-sol-text truncate hover:opacity-80 transition-opacity"
          >
            {name}
          </Link>
        </h1>

        <div className="repo-rise flex items-center gap-2 ml-auto" style={{ ["--d" as string]: "60ms" }}>
          {middle}
          {trailing}
          <RepoWindowControl />
          <a
            href={`https://github.com/${repository}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            GitHub
          </a>
        </div>
      </div>

      {below}

      <nav className="flex items-center gap-1 px-3 overflow-x-auto">
        {tabs.map(({ key, label, href, icon: Icon, digit }) => (
          <Link
            key={key}
            href={href}
            className={cn(
              "group flex items-center gap-2 border-b-2 px-3 py-1.5 text-[12px] whitespace-nowrap transition-colors",
              tab === key ? "border-current text-sol-text" : "border-transparent text-sol-text-muted hover:text-sol-text",
            )}
            style={tab === key ? { color: "var(--repo-accent)" } : undefined}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            <span className="opacity-0 group-hover:opacity-100 transition-opacity">
              <KeyCap size="xs">{digit}</KeyCap>
            </span>
          </Link>
        ))}
      </nav>
    </header>
  );
}
