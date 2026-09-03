// The chrome the three repository pages share: the header band with the
// repository's name, the branch it is showing, a way out to GitHub, and the
// two tabs (history and source) with their keyboard shortcuts.
import { useState, type ReactNode, type RefCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ExternalLink, GitBranch, History, Code2 } from "lucide-react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useEventListener } from "../../hooks/useEventListener";
import { repoHistoryHref, repoTreeHref } from "../../lib/repoView";
import { cn } from "../../lib/utils";

export type RepoTab = "history" | "code";

export function BranchPicker({
  branches,
  value,
  defaultBranch,
  onPick,
}: {
  branches: { name: string; sha: string }[];
  value: string;
  defaultBranch?: string;
  onPick: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = branches.filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 bg-sol-card px-2 text-[12px] text-sol-text hover:border-sol-border transition-colors"
        title="Switch branch"
      >
        <GitBranch className="w-3.5 h-3.5" style={{ color: "var(--repo-accent)" }} />
        <span className="max-w-[14rem] truncate">{value}</span>
        <ChevronDown className="w-3 h-3 text-sol-text-dim" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-64 rounded-lg border border-sol-border bg-sol-card shadow-lg overflow-hidden">
            <input
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Find a branch"
              className="w-full bg-transparent border-b border-sol-border/60 px-2.5 py-2 text-[12px] text-sol-text placeholder:text-sol-text-dim outline-none"
            />
            <div className="max-h-72 overflow-y-auto py-1">
              {shown.length === 0 && (
                <div className="px-2.5 py-3 text-[12px] text-sol-text-dim">No branch matches.</div>
              )}
              {shown.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onPick(branch.name);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-sol-text hover:bg-sol-bg-alt/60"
                >
                  <Check
                    className={cn("w-3 h-3 shrink-0", branch.name === value ? "opacity-100" : "opacity-0")}
                    style={{ color: "var(--repo-accent)" }}
                  />
                  <span className="truncate">{branch.name}</span>
                  {branch.name === defaultBranch && (
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
 * The band and the two tabs. `1` and `2` move between them, ignored while
 * typing so a filter box can contain a digit.
 */
export function RepoHeader({
  repository,
  tab,
  historyHref,
  codeHref,
  middle,
  trailing,
  below,
  headRef,
}: {
  repository: string;
  tab: RepoTab;
  historyHref: string;
  codeHref: string;
  /** Zen mode on the desktop makes this band the window titlebar. */
  headRef?: RefCallback<HTMLElement>;
  /** The branch picker, or whatever the page wants beside the name. */
  middle?: ReactNode;
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  const router = useRouter();
  const [owner, name] = repository.split("/");

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.key === "1" && tab !== "history") router.push(historyHref);
    if (e.key === "2" && tab !== "code") router.push(codeHref);
  });

  const tabs: { key: RepoTab; label: string; href: string; icon: typeof History; digit: string }[] = [
    { key: "history", label: "History", href: historyHref, icon: History, digit: "1" },
    { key: "code", label: "Code", href: codeHref, icon: Code2, digit: "2" },
  ];

  return (
    <header ref={headRef} className="repo-band border-b border-sol-border/60 shrink-0">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 flex-wrap">
        <h1 className="repo-rise flex items-baseline gap-1 min-w-0" style={{ ["--d" as string]: "0ms" }}>
          <Link href="/repo" className="text-[13px] text-sol-text-muted hover:text-sol-text transition-colors">
            {owner}
          </Link>
          <span className="text-sol-text-dim">/</span>
          <Link
            href={historyHref}
            className="font-serif text-[19px] leading-none text-sol-text truncate hover:opacity-80 transition-opacity"
          >
            {name}
          </Link>
        </h1>

        <div className="repo-rise flex items-center gap-2 ml-auto" style={{ ["--d" as string]: "60ms" }}>
          {middle}
          {trailing}
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

      <nav className="flex items-center gap-1 px-3">
        {tabs.map(({ key, label, href, icon: Icon, digit }) => (
          <Link
            key={key}
            href={href}
            className={cn(
              "group flex items-center gap-2 border-b-2 px-3 py-1.5 text-[12px] transition-colors",
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
