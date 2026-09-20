import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Copy, FolderGit2, Laptop, Play } from "lucide-react";
import type { WorktreeEntry } from "@codecast/shared/contracts";
import { LoadingSkeleton } from "../LoadingSkeleton";
import { AuthorAvatar } from "../entityDisplay";
import { WorktreeConditionLine, WorktreeSessions } from "../worktree/WorktreePill";
import { groupWorktrees, type WorktreeGroup } from "../worktree/worktreeModel";
import { useRepoWorktrees, type RepoCheckout } from "../../hooks/useRepoBrowse";
import { useRepoLocation } from "./useRepoFamily";
import { useInboxStore } from "../../store/inboxStore";
import { commitPageHref, repoCompareHref, repoTreeHref } from "../../lib/repoView";
import { copyToClipboard, relTimeShort } from "../../lib/utils";
import { serverErrorText } from "../../lib/errorCause";

/** Groups this long start folded: a busy repository holds hundreds of agent worktrees nobody browses. */
const FOLD_OVER = 12;

/** A new session in a worktree, on the machine that holds it. Same local first launch as every other composer. */
function startSessionIn(checkout: RepoCheckout, worktree: WorktreeEntry) {
  const store = useInboxStore.getState() as any;
  const { stubId } = store.beginOptimisticSession({
    agentType: "claude_code",
    projectPath: worktree.path,
    gitRoot: checkout.root,
    create: (sid: string) => store.createSession({
      agent_type: "claude_code",
      project_path: worktree.path,
      git_root: checkout.root,
      session_id: sid,
      ...(checkout.device_id ? { target_device_id: checkout.device_id } : {}),
    }),
  });
  store.requestNavigate(stubId, { source: "gesture" });
}

function WorktreeRow({ repository, checkout, worktree: w, focused }: { repository: string; checkout: RepoCheckout; worktree: WorktreeEntry; focused: boolean }) {
  const comparable = !w.main && !!w.branch && (w.ahead ?? 0) > 0;
  return (
    <div id={encodeURIComponent(w.name)} className={`group px-4 py-3.5 flex gap-3 items-start scroll-mt-24 transition-colors ${focused ? "bg-[color-mix(in_srgb,var(--repo-accent)_9%,transparent)]" : ""}`}>
      <FolderGit2 className={`size-4 mt-0.5 shrink-0 ${w.sessions?.length ? "text-[var(--repo-accent)]" : "text-sol-text-dim"}`} />
      <div className="flex-1 min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="font-mono text-sol-text">{w.name}</span>
          {w.branch
            ? <Link href={repoTreeHref(repository, w.branch, undefined, "app")} className="font-mono text-xs text-sol-blue truncate max-w-[40ch]">{w.branch}</Link>
            : <span className="text-xs text-sol-text-dim">detached</span>}
          <Link href={commitPageHref(repository, w.head_sha, "app")} className="font-mono text-xs text-sol-text-dim hover:text-sol-text">{w.head_sha.slice(0, 7)}</Link>
          {w.locked && <span className="text-[10px] border border-sol-border rounded-full px-2">locked</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <WorktreeConditionLine found={{ worktree: w, checkout }} />
          {comparable && <Link className="text-sol-blue" href={repoCompareHref(repository, checkout.default_branch, w.branch!, "app")}>Compare</Link>}
          {!!w.ports && <span className="font-mono text-sol-text-dim">{Object.entries(w.ports).map(([name, port]) => `${name} :${port}`).join("  ")}</span>}
        </div>
        {w.subject && (
          <div className="text-xs text-sol-text-dim truncate">
            {w.subject}{!!w.committed_at && <time title={new Date(w.committed_at).toLocaleString()}> · {relTimeShort(w.committed_at)}</time>}
          </div>
        )}
        <WorktreeSessions sessions={w.sessions} limit={6} />
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          title={`Copy ${w.path}`}
          onClick={() => void copyToClipboard(w.path).then(() => toast.success("Path copied"))}
          className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-border"
        >
          <Copy className="size-3" /> Path
        </button>
        {checkout.mine && !w.prunable && w.state !== "destroying" && (
          <button
            type="button"
            title={`Start a session in ${w.name}${checkout.device_label ? ` on ${checkout.device_label}` : ""}`}
            onClick={() => startSessionIn(checkout, w)}
            className="flex items-center gap-1.5 h-7 rounded-md border border-sol-border/60 px-2 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-border"
          >
            <Play className="size-3" /> Session
          </button>
        )}
      </div>
    </div>
  );
}

function WorktreeGroupBlock({ repository, checkout, group, focus, filtering }: { repository: string; checkout: RepoCheckout; group: WorktreeGroup; focus: string; filtering: boolean }) {
  const holdsFocus = group.worktrees.some((w) => w.name === focus);
  const folds = group.key !== "main" && group.worktrees.length > FOLD_OVER;
  const [open, setOpen] = useState(!folds);
  const shown = open || filtering || holdsFocus;
  const occupied = group.worktrees.filter((w) => w.sessions?.length).length;
  return (
    <section>
      <button
        type="button"
        disabled={!folds}
        onClick={() => setOpen((v) => !v)}
        title={group.hint}
        className="w-full flex items-baseline gap-2 px-4 py-2 text-left text-[11px] uppercase tracking-wide text-sol-text-dim bg-sol-bg-alt/40 enabled:hover:text-sol-text"
      >
        <span>{group.label}</span>
        <span className="normal-case tracking-normal">{group.worktrees.length}{occupied ? ` · ${occupied} with sessions` : ""}</span>
        {folds && <span className="ml-auto normal-case tracking-normal">{shown ? "Hide" : "Show"}</span>}
      </button>
      {shown && <div className="divide-y divide-sol-border/40">
        {group.worktrees.map((w) => <WorktreeRow key={w.path} repository={repository} checkout={checkout} worktree={w} focused={w.name === focus} />)}
      </div>}
    </section>
  );
}

export function RepoWorktreesContent({ repository }: { repository: string }) {
  const read = useRepoWorktrees(repository);
  const [filter, setFilter] = useState("");
  const focus = decodeURIComponent(useRepoLocation().hash.replace(/^#/, ""));
  const ready = read.ready;
  useEffect(() => {
    if (ready && focus) document.getElementById(encodeURIComponent(focus))?.scrollIntoView({ block: "center" });
  }, [ready, focus]);

  const q = filter.trim().toLowerCase();
  const checkouts = (read.data?.checkouts ?? []).map((checkout) => ({
    checkout,
    groups: groupWorktrees(checkout.worktrees.filter((w) => !q || w.name.toLowerCase().includes(q) || (w.branch ?? "").toLowerCase().includes(q))),
  }));

  return <div className="max-w-[1200px] mx-auto">
    <div className="flex items-center gap-3 mb-4">
      <h2 className="font-serif text-xl text-sol-text">Worktrees</h2>
      <input aria-label="Filter worktrees" placeholder="Find a worktree or branch" value={filter} onChange={(e) => setFilter(e.target.value)} className="ml-auto border border-sol-border/60 rounded bg-sol-bg px-3 py-1.5 text-xs" />
    </div>
    {read.error && <p className="py-4 text-sol-red">{serverErrorText(read.error)}</p>}
    {!ready && !read.error && <LoadingSkeleton />}
    {ready && checkouts.length === 0 && (
      <p className="p-8 text-center text-sol-text-dim">
        No machine has published this repository's worktrees yet. A machine publishes them while a session runs in the repository, and again whenever <code className="font-mono">cast ws</code> makes or removes one.
      </p>
    )}
    <div className="space-y-6">
      {checkouts.map(({ checkout, groups }) => (
        <div key={`${checkout.owner?._id ?? ""}:${checkout.root}`} className="border border-sol-border/50 rounded-lg overflow-hidden">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 border-b border-sol-border/50">
            <Laptop className="size-4 shrink-0 text-[var(--repo-accent)]" />
            <span className="text-sol-text">{checkout.device_label ?? "A machine"}</span>
            {!checkout.mine && checkout.owner && (
              <span className="inline-flex items-center gap-1.5 text-xs"><AuthorAvatar name={checkout.owner.name} avatar={checkout.owner.image} size={14} />{checkout.owner.name}</span>
            )}
            <span className="font-mono text-xs text-sol-text-dim truncate">{checkout.root}</span>
            <time className="ml-auto text-xs text-sol-text-dim" title={new Date(checkout.at).toLocaleString()}>read {relTimeShort(checkout.at)}</time>
          </header>
          {checkout.truncated && <p className="px-4 py-2 text-xs text-sol-yellow">Showing the first 300 worktrees of this checkout.</p>}
          <div className="divide-y divide-sol-border/50">
            {groups.map((group) => <WorktreeGroupBlock key={group.key} repository={repository} checkout={checkout} group={group} focus={focus} filtering={!!q} />)}
          </div>
          {groups.length === 0 && <p className="p-6 text-center text-sol-text-dim">No matching worktrees.</p>}
        </div>
      ))}
    </div>
  </div>;
}
