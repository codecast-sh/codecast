import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Check, Search, Terminal, Users } from "lucide-react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { Input } from "../ui/input";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { formatRelative } from "../../lib/utils";
import {
  isMappedToTeam,
  type SuggestedWorkspace,
  type TeamWorkspaceSuggestions,
  type UserWorkspace,
} from "../../hooks/useTeamWorkspaceSuggestions";
import "./teamFlow.css";

// The selection state (seedWorkspaceSelection, useWorkspaceSelection) lives in
// hooks/useWorkspaceSelection so this file stays a clean Fast Refresh boundary.
// Selection follows --team-flow-accent inside the create flow and falls back
// to cyan elsewhere (see .tf-accent-scope in teamFlow.css).

function workspaceName(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Hints for repos that share a short name (two checkouts of "outreach").
 * Each duplicate gets the nearest ancestor segment where the group's paths
 * stop agreeing: two checkouts under different homes get the owner
 * (ashot, ec2-user), two under one home get the differing directory. The
 * parent directory alone fails on the common case of the same relative
 * path on two machines.
 */
function buildDupHints(paths: string[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const n = workspaceName(path);
    groups.set(n, [...(groups.get(n) ?? []), path]);
  }
  const hints = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const segs = group.map((p) => p.split("/").filter(Boolean));
    const maxLen = Math.max(...segs.map((s) => s.length));
    let depth = 1;
    while (depth < maxLen) {
      const vals = segs.map((s) => s[s.length - 1 - depth] ?? "");
      if (new Set(vals).size > 1) break;
      depth++;
    }
    for (let i = 0; i < group.length; i++) {
      const hint = segs[i][segs[i].length - 1 - depth];
      if (hint) hints.set(group[i], hint);
    }
  }
  return hints;
}

/**
 * The workspace share step: matched repos, the rest, the empty state that
 * points at the CLI, and repos teammates share that the viewer lacks locally.
 * `isNewTeam` swaps the copy for a team nobody has joined yet, where no
 * teammate matches can exist.
 */
export function WorkspaceSharePicker({
  data,
  teamId,
  selectedPaths,
  onToggle,
  isNewTeam = false,
  className = "",
}: {
  data: TeamWorkspaceSuggestions;
  teamId: Id<"teams"> | null;
  selectedPaths: Record<string, boolean>;
  onToggle: (path: string) => void;
  isNewTeam?: boolean;
  className?: string;
}) {
  const { allProjects, matched, other, teamName, teamOnlyRepos, getSuggestion } = data;

  // Duplicate short names are computed across both sections, so a matched
  // repo and an unmatched twin still tell each other apart.
  const dupHints = buildDupHints([...matched, ...other].map((ws) => ws.path));

  // Type-to-filter, offered once the list outgrows a quick scan. It narrows
  // by short name or full path; selection is untouched, so a checked repo
  // stays checked while filtered out of view.
  const [filter, setFilter] = useState("");
  const total = matched.length + other.length;
  const filterable = total > 8;
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // "/" reaches the filter from anywhere on the step. Capture phase, so the
  // app's own "/" (global search) never sees the press while this list is
  // on screen. Text fields keep the key: paths contain slashes.
  useEffect(() => {
    if (!filterable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      e.preventDefault();
      e.stopPropagation();
      filterRef.current?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [filterable]);

  // Inside the filter: Esc clears the query first (a later Esc blurs, then
  // the shell walks back), ArrowDown hands focus to the first visible row.
  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && filter) {
      e.preventDefault();
      setFilter("");
      return;
    }
    if (e.key === "ArrowDown") {
      const first = rootRef.current?.querySelector<HTMLElement>('[role="checkbox"]');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const query = filter.trim().toLowerCase();
  const fits = (ws: UserWorkspace) => !query || ws.path.toLowerCase().includes(query);
  const matchedShown = query ? matched.filter(fits) : matched;
  const otherShown = query ? other.filter(fits) : other;
  const noneShown = query.length > 0 && matchedShown.length === 0 && otherShown.length === 0;

  // The last visible section takes the room the viewport can give (a CSS
  // clamp, no measurement); the sections above it keep the fixed clip. The
  // footer is sticky, so a long list can never push the actions off screen.
  const lastKey = otherShown.length > 0 ? "other" : "matched";
  const common = { selectedPaths, onToggle, getSuggestion, teamId, dupHints };

  return (
    <div ref={rootRef} className={`tf-accent-scope space-y-5 ${className}`}>
      {filterable && (
        <div className="group relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sol-text-dim"
          />
          <Input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onFilterKeyDown}
            placeholder={`Filter ${total} workspaces`}
            aria-label="Filter workspaces"
            aria-keyshortcuts="/"
            autoComplete="off"
            className="pl-9 pr-9 bg-sol-bg-alt border-sol-border text-sol-text focus-visible:ring-[var(--tf-acc)]"
          />
          {/* The promise that "/" lands here. It steps aside once the field
              is in use, and hides where there is no keyboard. Not tf-key-hint:
              display contents would drop the absolutely positioned box. */}
          {!filter && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 transition-opacity group-focus-within:opacity-0 [@media(pointer:coarse)]:hidden"
            >
              <KeyCap size="xs">/</KeyCap>
            </span>
          )}
        </div>
      )}

      {noneShown && (
        <p className="text-sm text-sol-text-dim">
          No workspaces match "{filter.trim()}".{" "}
          <button
            type="button"
            onClick={() => setFilter("")}
            className="tf-ghost rounded px-1 py-0.5 text-sol-text-dim underline decoration-sol-border underline-offset-2 hover:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tf-acc)]"
          >
            Clear
          </button>
        </p>
      )}

      {matchedShown.length > 0 && (
        <WorkspaceSection
          title="Shared by teammates"
          subtitle="Your teammates already share these repos. Pre-selected for you."
          workspaces={matchedShown}
          grow={lastKey === "matched"}
          {...common}
        />
      )}

      {otherShown.length > 0 && (
        <WorkspaceSection
          title={isNewTeam ? "Your workspaces" : "Your other workspaces"}
          // In the create flow the page description already says what to pick,
          // so a subtitle here would repeat the same sentence.
          subtitle={isNewTeam ? undefined : "Select any additional workspaces you'd like to share."}
          workspaces={otherShown}
          grow={lastKey === "other"}
          {...common}
        />
      )}

      {allProjects === undefined && (
        // Skeleton rows in the shape of the workspace list, so the step
        // does not reflow when the answer lands. Same recipe as the invite
        // step's placeholder.
        <div className="space-y-2" aria-busy="true">
          <div className="h-4 w-36 rounded bg-sol-bg-alt animate-pulse" />
          <div className="space-y-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[74px] rounded-lg border border-sol-border/50 bg-sol-bg-alt/40 animate-pulse" />
            ))}
          </div>
          <p className="text-sm text-sol-text-dim">Loading your workspaces.</p>
        </div>
      )}

      {allProjects && allProjects.length === 0 && (
        <div className="rounded-lg border border-sol-border bg-sol-bg-alt/40 px-4 py-5 space-y-3">
          <div className="text-sm text-sol-text font-medium">
            No workspaces found yet
          </div>
          <p className="text-xs text-sol-text-muted leading-relaxed">
            Workspaces appear here once you start sessions with the
            Codecast CLI. Install and authenticate, then your repos will
            be available to share.
          </p>
          <div className="font-mono text-xs text-sol-text-muted bg-sol-bg rounded-md px-3 py-2 select-all">
            curl -fsSL codecast.sh/install | sh
          </div>
          <p className="text-[11px] text-sol-text-dim">
            After installing, run{" "}
            <span className="font-mono text-sol-text-muted">cast auth</span>{" "}
            to connect your account, then start a session in any git
            repo.
          </p>
        </div>
      )}

      {teamOnlyRepos.length > 0 && (
        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-medium text-sol-text">
              Team repos you don't have yet
            </h3>
            <p className="text-xs text-sol-text-dim mt-0.5">
              These repos are shared by teammates but weren't found in
              your recent sessions. Clone them and map via the CLI.
            </p>
          </div>

          <div className="space-y-1.5">
            {teamOnlyRepos.map((repo) => (
              <div
                key={repo.repo_key}
                className="rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-sol-text-dim shrink-0" />
                  <span className="text-sm font-medium text-sol-text">
                    {repo.repo_key}
                  </span>
                  <span className="text-xs text-sol-text-dim">
                    {repo.member_count} teammate{repo.member_count === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-sol-border/60 bg-sol-bg-alt/50 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-sol-text">
              <Terminal className="tf-accent-text w-3.5 h-3.5" />
              Share a repo via CLI
            </div>
            <div className="font-mono text-xs text-sol-text-muted bg-sol-bg rounded-md px-3 py-2 select-all">
              {/* Quoted, so a multi-word team name still copies as one
                  argument through the select-all. */}
              cast teams map /path/to/repo "{teamName}"
            </div>
            <p className="text-[11px] text-sol-text-dim leading-relaxed">
              Clone the repo, then run the command above from anywhere.
              Or use{" "}
              <span className="font-mono text-sol-text-muted">
                cast sync-settings
              </span>{" "}
              for interactive setup.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceSection({
  title,
  subtitle,
  workspaces,
  selectedPaths,
  onToggle,
  getSuggestion,
  teamId,
  dupHints,
  grow,
}: {
  title: string;
  subtitle?: string;
  workspaces: UserWorkspace[];
  selectedPaths: Record<string, boolean>;
  onToggle: (path: string) => void;
  getSuggestion: (path: string) => SuggestedWorkspace | undefined;
  teamId: Id<"teams"> | null;
  dupHints: Map<string, string>;
  /** The last section takes a taller, viewport-relative clip. */
  grow?: boolean;
}) {
  // The list clips, so the fade says "more below" and the count says how
  // much. Both write DOM attributes directly: scroll position is not render
  // state, and a state write per scroll frame would churn.
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const updateFade = useCallback(() => {
    const list = listRef.current;
    const wrap = wrapRef.current;
    if (!list || !wrap) return;
    const below = list.scrollHeight - list.scrollTop - list.clientHeight > 4;
    wrap.dataset.canScroll = below ? "true" : "false";
  }, []);
  // The grown clip is viewport relative, so a resize can change what fits.
  useEffect(() => {
    updateFade();
    window.addEventListener("resize", updateFade);
    return () => window.removeEventListener("resize", updateFade);
  }, [workspaces.length, updateFade]);

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-sol-text">
          {title}
          <span className="ml-1.5 text-xs font-normal text-sol-text-dim tabular-nums">
            {workspaces.length}
          </span>
        </h3>
        {subtitle && <p className="text-xs text-sol-text-dim mt-0.5">{subtitle}</p>}
      </div>
      <div ref={wrapRef} className="tf-scroll-wrap">
        <div
          ref={listRef}
          onScroll={updateFade}
          // The last section gets the room the viewport can give; the ones
          // above keep the fixed clip. Pure CSS: the sticky footer already
          // guarantees the actions stay on screen, whatever this resolves to.
          className={`space-y-1.5 overflow-y-auto pr-0.5 ${
            grow ? "max-h-[clamp(320px,55dvh,40rem)]" : "max-h-[320px]"
          }`}
        >
        {workspaces.map((ws) => {
          const selected = !!selectedPaths[ws.path];
          const suggestion = getSuggestion(ws.path);
          const alreadyMapped = isMappedToTeam(ws, teamId);
          // Same short name as another row: the differing ancestor joins
          // the title as the tiebreaker.
          const hint = dupHints.get(ws.path);

          return (
            <button
              key={ws.path}
              type="button"
              role="checkbox"
              aria-checked={selected}
              onClick={() => onToggle(ws.path)}
              data-selected={selected}
              className={`tf-option w-full rounded-lg border px-4 py-3 text-left outline-none motion-safe:active:scale-[0.99] ${
                selected ? "" : "border-sol-border hover:border-sol-text-muted hover:bg-sol-bg-alt/40"
              }`}
            >
              <div className="flex items-start gap-3">
                {/* Visual only: aria-checked on the row carries the state. */}
                <div
                  aria-hidden="true"
                  className={`tf-check mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                    selected ? "" : "border-sol-border bg-sol-bg-alt"
                  }`}
                >
                  {selected && <Check className="w-3 h-3" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <GitBranch className="tf-accent-text w-4 h-4 shrink-0" />
                    <span className="truncate text-sm font-medium text-sol-text">
                      {workspaceName(ws.path)}
                    </span>
                    {hint && (
                      <span className="truncate text-xs text-sol-text-dim">
                        · {hint}
                      </span>
                    )}
                    {suggestion?.match_type === "github" && (
                      <span className="tf-accent-badge rounded border px-1.5 py-0.5 text-[10px] whitespace-nowrap">
                        GitHub match
                      </span>
                    )}
                    {alreadyMapped && (
                      <span className="rounded border border-sol-green/30 bg-sol-green/10 px-1.5 py-0.5 text-[10px] text-sol-green whitespace-nowrap">
                        Already shared
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-sol-text-dim">
                    {ws.path}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-sol-text-dim">
                    {suggestion && (
                      <span className="tf-accent-text">
                        <Users className="w-3 h-3 inline mr-1" />
                        {suggestion.match_reason}
                      </span>
                    )}
                    <span>
                      {ws.session_count} session
                      {ws.session_count === 1 ? "" : "s"}
                    </span>
                    {ws.last_active > 0 && (
                      <span>{formatRelative(ws.last_active)}</span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
        </div>
        <div className="tf-scroll-fade" aria-hidden="true" />
      </div>
    </div>
  );
}
